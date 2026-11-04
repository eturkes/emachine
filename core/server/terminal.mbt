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
  lease : TerminalLease?
  mut alive : Bool
  mut screen_size : (Int32, Int32)?
}

///|
struct Room {
  session : String
  mut cols : Int32
  mut rows : Int32
  mut controller : String
  mut peers : Array[Peer]
}

///|
fn terminal_state(room : Room, peer : Peer) -> Json {
  let mode = if peer.id == room.controller { "control" } else { "observe" }
  let fields : Map[String, Json] = {
    "type": "state",
    "session": room.session.to_json(),
    "mode": mode.to_json(),
    "cols": room.cols.to_json(),
    "rows": room.rows.to_json(),
  }
  if peer.screen_size is Some((cols, rows)) {
    fields["screenCols"] = cols.to_json()
    fields["screenRows"] = rows.to_json()
  }
  Json(fields)
}

///|
fn update_room(room : Room) -> Unit {
  ensure_terminal_controller(room)
  for peer in room.peers {
    if !peer.alive {
      continue
    }
    let okay = try {
      peer.terminal.resize(room.cols, room.rows)
      if peer.terminal.screen_size() is Some(size) {
        peer.screen_size = Some(size)
      }
      publish_terminal_packet(peer, Control(terminal_state(room, peer)))
    } catch {
      _ => false
    }
    if !okay {
      close_terminal_peer(peer)
    }
  }
}

///|
async fn refresh_terminal_screen(room : Room, peer : Peer) -> Unit {
  if !peer.alive {
    return
  }
  peer.terminal.refresh_screen()
  if peer.terminal.screen_size() is Some(size) && peer.screen_size != Some(size) {
    peer.screen_size = Some(size)
    send_terminal_packet(peer, Control(terminal_state(room, peer)))
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
  let bytes = @utf8.encode(session)
  if bytes.is_empty() ||
    bytes.length() > 48 ||
    session == "." ||
    session == ".." ||
    session.has_prefix("-") {
    return false
  }
  // Match JavaScript trim exactly while preserving internal spaces and Unicode.
  let whitespace = "\t\n\u000b\u000c\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\uFEFF"
  if session.trim(chars=whitespace).length() != session.length() {
    return false
  }
  // zmx uses socket basenames; controls and path separators cannot be names.
  for byte in bytes {
    let n = byte.to_int()
    if n < 32 || n == 127 || n == 47 || n == 92 {
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
  if query.split("&").any(part => part == "resume=1") {
    resumable_terminal_session(runtime, exchange, session, cwd, query)
  } else {
    legacy_terminal_session(runtime, exchange, session, cwd, query)
  }
}

///|
async fn legacy_terminal_session(
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
        lease: None,
        alive: true,
        screen_size: None,
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
          room.controller = ""
        }
        update_room(room)
      }
      update_room(room)
      group.spawn_bg(no_wait=true, () => {
        for ;; {
          // Silent programs and manual zmx clients can resize without producing bytes.
          // This samples cached identity at 4 Hz; unavailable metadata discovery backs off to 30 s.
          @async.sleep(250)
          refresh_terminal_screen(room, peer)
        }
      })
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
          // zmx follows its last input leader, which may be a manual terminal outside this room.
          // Report its observed screen grid before bytes without replacing our requested attach size.
          if terminal.screen_size() is Some(size) &&
            peer.screen_size != Some(size) {
            peer.screen_size = Some(size)
            peer.output.put(Control(terminal_state(room, peer)))
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
              "ping" => {
                refresh_terminal_screen(room, peer)
                peer.output.put(Control({ "type": "pong" }))
              }
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
