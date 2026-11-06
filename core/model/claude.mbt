///|
priv struct ClaudeSession {
  prefix : String
  cwd : String
  path : String
  status : String
}

///|
fn claude_status(value : String) -> String? {
  match value {
    "busy" | "shell" => Some("working")
    "idle" => Some("completed")
    "waiting" => Some("waiting")
    _ => None
  }
}

///|
async fn read_claude_session(root : String, name : String) -> ClaudeSession? {
  let path = safe_file(root, name)
  if @fs.kind(path) != Regular {
    return None
  }
  let file = @fs.open(path, mode=ReadOnly)
  defer file.close()
  if file.size() > 65536L {
    return None
  }
  let value = file.read_all().json()
  let pid = int_field(value, "pid")
  let id = string_field(value, "sessionId")
  if pid <= 1 ||
    name != "\{pid}.json" ||
    field(value, "pid") != pid.to_json() ||
    string_field(value, "kind") != "interactive" ||
    id.is_empty() {
    return None
  }
  guard claude_status(string_field(value, "status")) is Some(status) else {
    return None
  }
  if !@native.process_matches(
      pid,
      string_field(value, "procStart"),
      string_field(value, "pidDomain"),
    ) {
    return None
  }
  let cwd = string_field(value, "cwd")
  if !cwd.has_prefix("/") || @fs.kind(cwd) != Directory {
    return None
  }
  let prefix = id[:id.length().min(8)].to_owned()
  Some({ prefix, cwd, path: @fs.realpath(cwd), status, })
}

///|
async fn keeper_entries() -> Array[Json] {
  let base = @env.get_env_var("CACHE_KEEPALIVE_URL").unwrap_or(
    "http://127.0.0.1:8318",
  )
  guard base =~ re"^http://(127[.]0[.]0[.]1|localhost)(:[0-9]+)?/?$" else {
    return []
  }
  @async.with_timeout(250, () => {
    let client = @http.Client(base)
    defer client.close()
    guard client.get("/_keepalive").code == 200 else { return [] }
    let body = @buffer.Buffer()
    while client.read_some(max_len=8192) is Some(chunk) {
      if body.length() + chunk.length() > 262144 {
        return []
      }
      body.write_bytes(chunk)
    }
    match field(@json.parse(@utf8.decode(body.to_bytes())), "entries") {
      Array(entries) if entries.length() <= 512 => entries
      _ => []
    }
  })
}

///|
fn apply_keeper_activity(
  sessions : Array[ClaudeSession],
  entries : Array[Json],
) -> Unit {
  // The keeper publishes only the first eight characters of each session ID.
  // Require a unique match on both sides and the registry's launch directory.
  let unique : Map[String, Bool] = Map([])
  for session in sessions {
    unique[session.prefix] = !unique.contains(session.prefix)
  }
  let reports : Map[String, Json] = Map([])
  for entry in entries {
    let key = string_field(entry, "session")
    reports[key] = if reports.contains(key) { Json::null() } else { entry }
  }
  for i, session in sessions {
    guard session.status == "completed" && unique[session.prefix] else {
      continue
    }
    guard reports.get(session.prefix) is Some(entry) else { continue }
    let dir = string_field(entry, "dir")
    guard dir == session.cwd || dir == session.path else { continue }
    let working = match string_field(entry, "state") {
      "compacting" => true
      "ready" | "armed" | "compacted" | "lapsed" | "done" =>
        field(entry, "working") is True
      _ => false
    }
    if working {
      sessions[i] = { ..session, status: "working", }
    }
  }
}

///|
async fn claude_sessions() -> Array[ClaudeSession] {
  let result : Array[ClaudeSession] = []
  let root = @env.get_env_var("CLAUDE_CONFIG_DIR").unwrap_or(
      @env.get_env_var("HOME").unwrap_or("/nonexistent") + "/.claude",
    ) +
    "/sessions"
  try {
    if !@fs.exists(root) || @fs.kind(root) != Directory {
      return result
    }
    let names = @fs.readdir(root, sort=true)
    let mut read = 0
    for name in names {
      if !name.has_suffix(".json") {
        continue
      }
      if read >= 512 {
        break
      }
      read = read + 1
      try {
        if read_claude_session(root, name) is Some(session) {
          result.push(session)
        }
      } catch {
        error => if @async.is_being_cancelled() { raise error }
      }
    }
    if result.any(session => session.status == "completed") {
      apply_keeper_activity(result, keeper_entries())
    }
  } catch {
    error => if @async.is_being_cancelled() { raise error }
  }
  result
}

///|
fn session_activity(
  sessions : Array[ClaudeSession],
  includes_path : (String) -> Bool,
) -> String? {
  let mut status : String? = None
  for session in sessions {
    if !includes_path(session.path) {
      continue
    }
    if session.status == "waiting" {
      return Some("waiting")
    }
    if status is None || session.status == "working" {
      status = Some(session.status)
    }
  }
  status
}
