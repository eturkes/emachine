///|
enum Packet {
  Data(Bytes)
  Control(Json)
}

///|
struct Peer {
  id : String
  terminal : @pty.Pty
  output : @async.Queue[Packet]
  mut alive : Bool
}

///|
struct Room {
  session : String
  mut cols : Int
  mut rows : Int
  mut controller : String
  mut peers : Array[Peer]
}

///|
fn update_room(room : Room) -> Unit {
  for peer in room.peers {
    if !peer.alive {
      continue
    }
    let okay = try {
      peer.terminal.resize(room.cols, room.rows)
      let mode = if peer.id == room.controller { "control" } else { "observe" }
      peer.output.try_put(
        Control({
          "type": "state",
          "session": room.session.to_json(),
          "mode": mode.to_json(),
          "cols": room.cols.to_json(),
          "rows": room.rows.to_json(),
        }),
      )
    } catch {
      _ => false
    }
    if !okay {
      peer.alive = false
      peer.terminal.close()
    }
  }
}

///|
async fn terminal_socket(
  runtime : Runtime,
  exchange : Exchange,
  project_id : String,
  query : String,
) -> Unit {
  let project = @model.resolve_project(runtime.config, project_id)
  terminal_session(runtime, exchange, project.name, project.path, query)
}

///|
fn valid_general_session(session : String) -> Bool {
  if session == "general" {
    return true
  }
  if !session.has_prefix("general") || session.length() > 48 {
    return false
  }
  let number = session[7:].to_owned()
  if number.is_empty() || number == "1" || number.has_prefix("0") {
    return false
  }
  for byte in @utf8.encode(number) {
    let n = byte.to_int()
    if n < 48 || n > 57 {
      return false
    }
  }
  true
}

///|
async fn general_terminal_socket(
  runtime : Runtime,
  exchange : Exchange,
  session : String,
  query : String,
) -> Unit {
  if !valid_general_session(session) {
    fail("Invalid General terminal session")
  }
  let home = @env.get_env_var("HOME").unwrap_or("")
  if !home.has_prefix("/") || @fs.kind(home) != Directory {
    fail("The server user's home directory is unavailable")
  }
  terminal_session(runtime, exchange, session, home, query)
}

///|
async fn terminal_session(
  runtime : Runtime,
  exchange : Exchange,
  session : String,
  cwd : String,
  query : String,
) -> Unit {
  let cols = dimension(query, "cols", 100)
  let rows = dimension(query, "rows", 30)
  let room = match runtime.rooms.get(session) {
    Some(room) => room
    None => {
      let room : Room = { session, cols, rows, controller: "", peers: [], }
      runtime.rooms[session] = room
      room
    }
  }
  if room.peers.is_empty() {
    room.cols = cols
    room.rows = rows
  }
  exchange.replied = true
  let socket = @websocket.from_http_server(
    exchange.request,
    exchange.connection,
  )
  defer socket.close()
  let result : Result[Unit, String] = try {
    @async.with_task_group() <| group => {
      let terminal = @pty.spawn(
        group,
        cwd,
        room.session,
        runtime.config.shell,
        room.cols,
        room.rows,
      )
      defer terminal.close()
      let peer : Peer = {
        id: @native.random_id(),
        terminal,
        output: @async.Queue(kind=Blocking(256)),
        alive: true,
      }
      room.peers.push(peer)
      if room.controller.is_empty() {
        room.controller = peer.id
      }
      defer {
        peer.alive = false
        peer.output.close()
        room.peers = room.peers.filter(candidate => candidate.id != peer.id)
        if room.controller == peer.id {
          room.controller = if room.peers.is_empty() {
            ""
          } else {
            room.peers[0].id
          }
        }
        update_room(room)
      }
      update_room(room)
      group.spawn_bg(no_wait=true, () => {
        for ;; {
          match peer.output.get() {
            Data(bytes) => socket.send_binary(bytes)
            Control(value) => socket.send_text(value.stringify())
          }
        }
      })
      group.spawn_bg(no_wait=true, () => {
        for ;; {
          let data = terminal.read()
          if data.is_empty() {
            socket.close()
            break
          }
          peer.output.put(Data(data))
        }
      })
      for ;; {
        let message = socket.recv()
        let data = bounded_read(message, 65536)
        match message.kind {
          Binary => if room.controller == peer.id { terminal.write(data) }
          Text => {
            let control = @json.parse(@utf8.decode(data), max_nesting_depth=8)
            match @model.string_field(control, "type") {
              "resize" if room.controller == peer.id => {
                let next_cols = @model.int_field(control, "cols")
                let next_rows = @model.int_field(control, "rows")
                if next_cols < 2 ||
                  next_cols > 500 ||
                  next_rows < 2 ||
                  next_rows > 500 {
                  fail("Invalid terminal dimensions")
                }
                if next_cols != room.cols || next_rows != room.rows {
                  room.cols = next_cols
                  room.rows = next_rows
                  update_room(room)
                }
              }
              "claim" => {
                room.controller = peer.id
                update_room(room)
              }
              "ping" => peer.output.put(Control({ "type": "pong" }))
              _ => ()
            }
          }
        }
      }
    }
    Ok(())
  } catch {
    error => Err(error.to_string())
  }
  if result is Err(message) && !@async.is_being_cancelled() {
    socket.send_text(
      ({ "type": "error", "message": message.to_json() } : Json).stringify(),
    ) catch {
      _ => ()
    }
  }
}
