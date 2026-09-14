///|
struct Runtime {
  config : @model.Config
  group : @async.TaskGroup[Unit]
  mut state : @model.State
  mut state_json : String
  events : Map[String, @async.Queue[Json]]
  rooms : Map[String, Room]
  jobs : Map[String, Job]
  mut last_error : String
}

///|
struct Exchange {
  request : @http.Request
  connection : @http.ServerConnection
  headers : @http.Headers
  mut replied : Bool
}

///|
fn publish(runtime : Runtime, value : Json) -> Unit {
  for _, queue in runtime.events { let _ = queue.try_put(value) catch { _ => false } }
}

///|
async fn json_response(exchange : Exchange, code : Int, value : Json) -> Unit {
  exchange.replied = true
  exchange.headers["Content-Type"] = "application/json; charset=utf-8"
  exchange.headers["Connection"] = "close"
  exchange.connection.send_response(code, if code < 400 { "OK" } else { "Error" }, extra_headers=exchange.headers)
  exchange.connection.write_string(value.stringify())
  exchange.connection.end_response()
}

///|
async fn file_response(exchange : Exchange, root : String, relative : String, immutable? : Bool = false, shell? : Bool = false) -> Unit {
  let path = @model.safe_file(root, relative)
  if @fs.kind(path) != Regular { fail("Not a regular file") }
  let file = @fs.open(path, mode=ReadOnly)
  defer file.close()
  if file.size() > 67108864L { fail("File exceeds the 64 MiB serving limit") }
  exchange.headers["Content-Type"] = @model.content_type(path)
  exchange.headers["Cache-Control"] = if immutable { "private, max-age=31536000, immutable" } else { "no-cache" }
  exchange.headers["Connection"] = "close"
  if shell {
    exchange.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https: wss: http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*; frame-src https: http://127.0.0.1:* http://localhost:*; img-src 'self' data: blob:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  }
  exchange.replied = true
  exchange.connection.send_response(200, "OK", extra_headers=exchange.headers)
  exchange.connection.write_reader(file)
  exchange.connection.end_response()
}

///|
async fn event_socket(runtime : Runtime, exchange : Exchange) -> Unit {
  exchange.replied = true
  let socket = @websocket.from_http_server(exchange.request, exchange.connection)
  defer socket.close()
  let id = @native.random_id()
  let queue : @async.Queue[Json] = @async.Queue(kind=DiscardOldest(16))
  runtime.events[id] = queue
  defer { runtime.events.remove(id); queue.close() }
  queue.put({"type":"inventory", "state":@json.to_json(runtime.state)})
  @async.with_task_group() <| group => {
    group.spawn_bg(no_wait=true, () => {
      for ;; { socket.send_text(queue.get().stringify()) }
    })
    for ;; {
      let message = socket.recv()
      let _ = bounded_read(message, 4096)
      queue.put({"type":"pong"})
    }
  }
}

///|
async fn route(runtime : Runtime, exchange : Exchange, body : &@io.Reader) -> Unit {
  let request = exchange.request
  let upgrade = request.headers.get("Upgrade").unwrap_or("").to_lower() == "websocket"
  let requires_origin = upgrade || request.meth == Post
  if !authorized(runtime.config, request.headers, requires_origin) {
    json_response(exchange, 403, {"error":"Access denied. Use an authorized Tailscale connection or the authenticated gateway, and a configured client origin."})
    return
  }
  if request.meth == Options {
    exchange.headers["Access-Control-Max-Age"] = "600"
    json_response(exchange, 200, {"ok":true})
    return
  }
  if request.path.length() > 8192 { fail("Request path is too long") }
  let (raw_path, query) = match request.path.split_once("?") {
    Some((path, query)) => (path.to_owned(), query.to_owned())
    None => (request.path, "")
  }
  let decoded = @model.url_decode(raw_path)
  if !decoded.has_prefix("/") { fail("Invalid request path") }
  let parts = decoded[1:].split("/").map(value => value.to_owned()).to_array()
  if upgrade {
    if request.meth != Get { fail("WebSocket upgrades require GET") }
    match parts {
      ["api", "v1", "events"] => event_socket(runtime, exchange)
      ["api", "v1", "terminal", project] => terminal_socket(runtime, exchange, project, query)
      _ => json_response(exchange, 404, {"error":"Unknown WebSocket endpoint"})
    }
    return
  }
  if request.meth == Post {
    let bytes = @async.with_timeout(30000, () => bounded_read(body, 524288))
    let input = @json.parse(@utf8.decode(bytes), max_nesting_depth=32)
    match parts {
      ["api", "v1", "projects", project, "features", feature, "jobs"] => {
        let job = start_job(runtime, project, feature, @model.string_field(input, "action"), @model.field(input, "input"))
        json_response(exchange, 202, @json.to_json(job))
      }
      ["api", "v1", "projects", project, "features", feature, "errors"] => {
        let receipt = @features.get_active(runtime.config, project, feature)
        if receipt.feature.revision != @model.string_field(input, "revision") { fail("Render report belongs to an inactive revision") }
        let message = @model.string_field(input, "message")
        if message.length() > 8192 { fail("Render diagnostic exceeds its size limit") }
        let diagnostic : @model.Diagnostic = { feature, message, updatedAt: @native.now_ms() }
        let base = @model.feature_data(runtime.config, project, feature)
        @model.atomic_json(base + "/render-diagnostic.json", @json.to_json(diagnostic))
        json_response(exchange, 200, {"ok":true})
      }
      _ => json_response(exchange, 404, {"error":"Unknown action endpoint"})
    }
    return
  }
  if request.meth != Get { json_response(exchange, 405, {"error":"Method not allowed"}); return }
  match parts {
    ["api", "v1", "health"] => json_response(exchange, 200, {"ok":true, "protocol":1})
    ["api", "v1", "state"] => json_response(exchange, 200, @json.to_json(runtime.state))
    ["api", "v1", "jobs"] => {
      let jobs : Array[Json] = []
      for _, job in runtime.jobs { jobs.push(@json.to_json(job)) }
      json_response(exchange, 200, {"jobs":jobs.to_json()})
    }
    ["api", "v1", "jobs", id] => {
      match runtime.jobs.get(id) {
        Some(job) => json_response(exchange, 200, @json.to_json(job))
        None => json_response(exchange, 404, {"error":"Unknown job"})
      }
    }
    ["api", "v1", "jobs", id, "log"] => {
      if !@model.valid_id(id) || runtime.jobs.get(id) is None { fail("Unknown job") }
      let text = @features.tail_text(runtime.config.stateRoot + "/jobs/" + id + ".log")
      exchange.replied = true
      exchange.headers["Content-Type"] = "text/plain; charset=utf-8"
      exchange.headers["Connection"] = "close"
      exchange.connection.send_response(200, "OK", extra_headers=exchange.headers)
      exchange.connection.write_string(text)
      exchange.connection.end_response()
    }
    ["api", "v1", "features", project, feature, revision, ..rest] => {
      if !valid_revision(revision) { fail("Invalid feature revision") }
      let base = @model.feature_data(runtime.config, project, feature)
      if !@fs.exists(base + "/receipts/" + revision + ".json") { fail("Unknown feature release") }
      exchange.headers["Content-Security-Policy"] = "frame-ancestors 'self' " + runtime.config.allowedOrigins.join(" ")
      file_response(exchange, base + "/releases/" + revision, rest.to_array().join("/"), immutable=true)
    }
    ["api", "v1", "artifacts", project, feature, ..rest] => {
      let _ = @features.get_active(runtime.config, project, feature)
      file_response(exchange, @features.state_path(runtime.config, project, feature) + "/artifacts", rest.to_array().join("/"))
    }
    ["bootstrap.json"] => {
      let config = runtime.config
      json_response(exchange, 200, {"servers":[{"id":config.machineId.to_json(), "name":config.machineName.to_json(),
        "direct":config.directUrl.to_json(), "gateway":config.gatewayUrl.to_json()}]})
    }
    _ => {
      if decoded.has_prefix("/api/") { json_response(exchange, 404, {"error":"Unknown API endpoint"}); return }
      let relative = if decoded == "/" { "index.html" } else { decoded[1:].to_owned() }
      file_response(exchange, runtime.config.webRoot, relative, shell=true)
    }
  }
}

///|
pub async fn serve(config : @model.Config) -> Unit {
  @signal.set_global_cancellation_signals([SIGINT, SIGTERM])
  @model.initialize(config)
  @model.ensure_dir(config.runtimeRoot + "/zmx")
  let lock = @fs.open(config.runtimeRoot + "/server.lock", mode=ReadWrite, create_mode=OpenOrCreate, permission=384)
  defer lock.close()
  if !lock.try_lock(Exclusive) { fail("An emachine server already owns this runtime directory") }
  let listener = @http.Server(@socket.Addr::parse("127.0.0.1:\{config.port}"), reuse_addr=true)
  defer listener.close()
  @async.with_task_group() <| group => {
    let state = @features.inventory(config)
    let runtime : Runtime = { config, group, state, state_json: @json.to_json(state).stringify(),
      events: {}, rooms: {}, jobs: {}, last_error: "" }
    recover_jobs(runtime)
    group.spawn_bg(no_wait=true, () => {
      for ;; {
        @async.sleep(1000)
        try {
          let next = @features.inventory(config)
          let serialized = @json.to_json(next).stringify()
          if serialized != runtime.state_json {
            runtime.state = next
            runtime.state_json = serialized
            publish(runtime, {"type":"inventory", "state":@json.to_json(next)})
          }
          runtime.last_error = ""
          run_automatic(runtime)
        } catch {
          error => {
            if @async.is_being_cancelled() { raise error }
            let message = error.to_string()
            if message != runtime.last_error {
              runtime.last_error = message
              publish(runtime, {"type":"error", "message":message.to_json()})
              println("Inventory: " + message)
            }
          }
        }
      }
    })
    println("emachine \{config.machineName}: http://127.0.0.1:\{config.port}")
    listener.run_forever(allow_failure=true, max_connections=128, (request, body, connection) => {
      defer connection.close()
      let exchange : Exchange = { request, connection, headers: response_headers(config, request), replied: false }
      route(runtime, exchange, body) catch {
        error => {
          if !exchange.replied && !@async.is_being_cancelled() {
            json_response(exchange, 400, {"error":error.to_string().to_json()})
          }
        }
      }
    })
  }
}
