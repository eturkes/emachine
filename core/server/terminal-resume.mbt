///|
priv struct TerminalEvent {
  packet : Packet
  bytes : Int32
}

///|
priv struct TerminalBinding {
  id : String
  socket : @websocket.Conn
  wake : @async.Queue[Unit]
  gzip : Bool
  mut ready : Bool
  mut pong : Bool
}

///|
priv struct TerminalLease {
  journal : Map[Int64, TerminalEvent]
  start : @async.Queue[Unit]
  mut first : Int64
  mut sequence : Int64
  mut bytes : Int32
  mut expires : Int64
  mut binding : TerminalBinding?
}

///|
fn terminal_peer_connected(peer : Peer) -> Bool {
  peer.alive &&
  (match peer.lease {
    None => true
    Some(lease) => lease.binding is Some(_)
  })
}

///|
fn ensure_terminal_controller(room : Room) -> Unit {
  if room.peers.any(peer => {
      peer.id == room.controller && terminal_peer_connected(peer)
    }) {
    return
  }
  room.controller = ""
  for peer in room.peers {
    if terminal_peer_connected(peer) {
      room.controller = peer.id
      break
    }
  }
}

///|
fn close_terminal_peer(peer : Peer) -> Unit {
  peer.alive = false
  peer.terminal.close()
  if peer.lease is Some(lease) && lease.binding is Some(binding) {
    lease.binding = None
    binding.socket.close()
    binding.wake.close()
  }
}

///|
fn terminal_binding_current(
  peer : Peer,
  lease : TerminalLease,
  binding : TerminalBinding,
) -> Bool {
  peer.alive &&
  (match lease.binding {
    Some(current) => current.id == binding.id
    None => false
  })
}

///|
fn terminal_wake(lease : TerminalLease) -> Unit {
  if lease.binding is Some(binding) {
    let _ = binding.wake.try_put(()) catch { _ => false }
  }
}

///|
/// Data and geometry share one bounded journal so a reconnect cannot render
/// missed bytes using a later grid or acknowledge a packet it has not parsed.
fn publish_terminal_packet(peer : Peer, packet : Packet) -> Bool raise {
  guard peer.lease is Some(lease) else { return peer.output.try_put(packet) }
  if !peer.alive || lease.sequence >= 9007199254740991L {
    return false
  }
  let bytes = match packet {
    Data(data) => data.length() + 8
    Control(value) => @utf8.encode(value.stringify()).length() + 32
  }
  lease.sequence += 1L
  lease.journal[lease.sequence] = { packet, bytes, }
  lease.bytes += bytes
  while lease.bytes > 8388608 || lease.sequence - lease.first >= 4096L {
    if lease.journal.get(lease.first) is Some(event) {
      lease.bytes -= event.bytes
    }
    lease.journal.remove(lease.first)
    lease.first += 1L
  }
  terminal_wake(lease)
  true
}

///|
async fn send_terminal_packet(peer : Peer, packet : Packet) -> Unit {
  match peer.lease {
    None => peer.output.put(packet)
    Some(_) =>
      if !publish_terminal_packet(peer, packet) {
        close_terminal_peer(peer)
      }
  }
}

///|
fn terminal_sequence(control : Json) -> Int64? {
  match @model.field(control, "sequence") {
    Number(value, ..) if value >= 0.0 && value <= 9007199254740991.0 => {
      let sequence = value.to_int64()
      if sequence.to_double() == value {
        Some(sequence)
      } else {
        None
      }
    }
    _ => None
  }
}

///|
fn terminal_checkpoint_available(
  lease : TerminalLease,
  sequence : Int64,
) -> Bool {
  sequence >= lease.first - 1L && sequence <= lease.sequence
}

///|
fn terminal_sequenced_data(
  sequence : Int64,
  bytes : Bytes,
  gzip : Bool,
) -> Bytes {
  let compressed = if gzip { @native.terminal_gzip(bytes) } else { None }
  let payload = compressed.unwrap_or(bytes)
  let header = if gzip { 13 } else { 8 }
  let result : FixedArray[Byte] = FixedArray::make(payload.length() + header, 0)
  for index = 0; index < 8; index = index + 1 {
    result[index] = ((sequence >> ((7 - index) * 8)) & 255L).to_int().to_byte()
  }
  if gzip {
    result[8] = if compressed is Some(_) { 1 } else { 0 }
    for index = 0; index < 4; index = index + 1 {
      result[9 + index] = ((bytes.length() >> ((3 - index) * 8)) & 255).to_byte()
    }
  }
  FixedArray::blit_from_bytes(result, header, payload, 0, payload.length())
  result.unsafe_reinterpret_as_bytes()
}

///|
fn terminal_sequenced_state(sequence : Int64, value : Json) -> Json {
  let fields : Map[String, Json] = Map([])
  if value is Object(original) {
    for key, item in original {
      fields[key] = item
    }
  }
  fields["sequence"] = sequence.to_double().to_json()
  Json(fields)
}

///|
/// The per-attachment byte cap also needs a process cap: rapid new connections
/// must not accumulate an unbounded number of detached leases during the grace.
fn trim_detached_terminals(runtime : Runtime) -> Unit {
  let detached : Array[Peer] = []
  for _, room in runtime.rooms {
    for peer in room.peers {
      if peer.alive && peer.lease is Some(lease) && lease.binding is None {
        detached.push(peer)
      }
    }
  }
  while detached.length() > 32 {
    let mut oldest = 0
    for index = 1; index < detached.length(); index = index + 1 {
      if detached[index].lease.unwrap().expires <
        detached[oldest].lease.unwrap().expires {
        oldest = index
      }
    }
    close_terminal_peer(detached[oldest])
    detached.remove(oldest) |> ignore
  }
}

///|
async fn start_terminal_lease(
  runtime : Runtime,
  room : Room,
  cwd : String,
) -> Peer {
  let ready : @async.Queue[Peer] = @async.Queue(kind=Blocking(1))
  runtime.group.spawn_bg(no_wait=true, allow_failure=true, () => {
    try
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
        let lease : TerminalLease = {
          journal: {},
          start: @async.Queue(kind=DiscardOldest(1)),
          first: 1L,
          sequence: 0L,
          bytes: 0,
          expires: @async.now() + 30000L,
          binding: None,
        }
        let peer : Peer = {
          id: @native.random_id(),
          terminal,
          output: @async.Queue(kind=Blocking(1)),
          lease: Some(lease),
          alive: true,
          screen_size: None,
        }
        room.peers.push(peer)
        defer {
          close_terminal_peer(peer)
          peer.output.close()
          lease.start.close()
          room.peers = room.peers.filter(candidate => candidate.id != peer.id)
          update_room(room)
        }
        ready.put(peer)
        // Let the fresh client finish negotiation before exposing zmx queries.
        @async.with_timeout(5000, () => lease.start.get())
        group.spawn_bg(no_wait=true, () => {
          while peer.alive {
            let data = terminal.read()
            if data.is_empty() {
              close_terminal_peer(peer)
              break
            }
            if terminal.screen_size() is Some(size) &&
              peer.screen_size != Some(size) {
              peer.screen_size = Some(size)
              send_terminal_packet(peer, Control(terminal_state(room, peer)))
            }
            send_terminal_packet(peer, Data(data))
          }
        })
        while peer.alive {
          @async.sleep(250)
          if lease.binding is None && @async.now() >= lease.expires {
            break
          }
          refresh_terminal_screen(room, peer)
        }
      }
    catch {
      error => {
        ready.close(error~)
        if @async.is_being_cancelled() {
          raise error
        }
      }
    }
  })
  ready.get()
}

///|
async fn send_terminal_resume(
  peer : Peer,
  lease : TerminalLease,
  binding : TerminalBinding,
  checkpoint : Int64,
  ready_at : Int64,
  resumed : Bool,
) -> Unit {
  let hello : Map[String, Json] = {
    "type": "resume",
    "attachment": peer.id.to_json(),
    "sequence": checkpoint.to_double().to_json(),
    "resumed": resumed.to_json(),
  }
  if binding.gzip {
    hello["encoding"] = "gzip-v1"
  }
  binding.socket.send_text(Json(hello).stringify())
  let mut cursor = checkpoint
  while terminal_binding_current(peer, lease, binding) {
    if !binding.ready && cursor == ready_at {
      binding.socket.send_text(({ "type": "ready" } : Json).stringify())
      if !terminal_binding_current(peer, lease, binding) {
        break
      }
      binding.ready = true
      let _ = lease.start.try_put(())
    }
    if cursor < lease.sequence {
      guard lease.journal.get(cursor + 1L) is Some(event) else {
        // A very slow client can outrun the retention window even while attached.
        // Closing forces an explicit full restore, never a silently skipped gap.
        binding.socket.close()
        break
      }
      cursor += 1L
      match event.packet {
        Data(bytes) =>
          binding.socket.send_binary(
            terminal_sequenced_data(cursor, bytes, binding.gzip),
          )
        Control(value) =>
          binding.socket.send_text(
            terminal_sequenced_state(cursor, value).stringify(),
          )
      }
      continue
    }
    if binding.pong {
      binding.pong = false
      binding.socket.send_text(({ "type": "pong" } : Json).stringify())
    }
    binding.wake.get()
  }
}

///|
async fn receive_terminal_resume(
  room : Room,
  peer : Peer,
  lease : TerminalLease,
  binding : TerminalBinding,
) -> Unit {
  while terminal_binding_current(peer, lease, binding) {
    let message = binding.socket.recv()
    let data = bounded_read(message, 65536)
    if !terminal_binding_current(peer, lease, binding) {
      break
    }
    match message.kind {
      Binary =>
        if binding.ready && room.controller == peer.id {
          peer.terminal.write(data)
        }
      Text => {
        let control = @json.parse(@utf8.decode(data), max_nesting_depth=8)
        match @model.string_field(control, "type") {
          "detach" => {
            close_terminal_peer(peer)
            update_room(room)
            break
          }
          "resize" if binding.ready && room.controller == peer.id => {
            let cols = @model.int_field(control, "cols")
            let rows = @model.int_field(control, "rows")
            if cols < 2 || cols > 500 || rows < 2 || rows > 500 {
              fail("Invalid terminal dimensions")
            }
            if cols != room.cols || rows != room.rows {
              room.cols = cols
              room.rows = rows
              update_room(room)
            }
          }
          "claim" if binding.ready => {
            room.controller = peer.id
            update_room(room)
          }
          "ping" => {
            refresh_terminal_screen(room, peer)
            binding.pong = true
            terminal_wake(lease)
          }
          _ => ()
        }
      }
    }
  }
}

///|
async fn resumable_terminal_session(
  runtime : Runtime,
  exchange : Exchange,
  session : String,
  cwd : String,
  query : String,
) -> Unit {
  exchange.replied = true
  let socket = @websocket.from_http_server(
    exchange.request,
    exchange.connection,
  )
  defer socket.close()
  let result : Result[Unit, String] = try {
    // Resume tokens belong in authenticated message bodies, never request URLs.
    let hello = @async.with_timeout(5000, () => {
      let message = socket.recv()
      guard message.kind is Text else {
        fail("Expected terminal resume negotiation")
      }
      let control = @json.parse(
        @utf8.decode(bounded_read(message, 1024)),
        max_nesting_depth=4,
      )
      if @model.string_field(control, "type") != "resume" {
        fail("Expected terminal resume negotiation")
      }
      control
    })
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
    let attachment = @model.string_field(hello, "attachment")
    let checkpoint = terminal_sequence(hello)
    let mut candidate : Peer? = None
    for peer in room.peers {
      if peer.id == attachment && peer.alive && peer.lease is Some(_) {
        candidate = Some(peer)
        break
      }
    }
    let mut resumed = false
    let mut cursor = 0L
    let peer = match (candidate, checkpoint) {
      (Some(peer), Some(sequence)) if terminal_checkpoint_available(
          peer.lease.unwrap(),
          sequence,
        ) &&
        (
          peer.lease.unwrap().binding is Some(_) ||
          @async.now() < peer.lease.unwrap().expires
        ) => {
        resumed = true
        cursor = sequence
        peer
      }
      _ => {
        // A foreign room's token cannot release that room's attachment.
        if candidate is Some(peer) {
          close_terminal_peer(peer)
        }
        if !room.peers.any(peer => peer.alive) {
          room.cols = cols
          room.rows = rows
        }
        start_terminal_lease(runtime, room, cwd)
      }
    }
    let lease = peer.lease.unwrap()
    let binding : TerminalBinding = {
      id: @native.random_id(),
      socket,
      wake: @async.Queue(kind=DiscardOldest(1)),
      gzip: @model.string_field(hello, "encoding") == "gzip-v1",
      ready: false,
      pong: false,
    }
    let previous = lease.binding
    lease.binding = Some(binding)
    if previous is Some(previous) {
      previous.socket.close()
      previous.wake.close()
    }
    defer {
      if terminal_binding_current(peer, lease, binding) {
        lease.binding = None
        lease.expires = @async.now() + 30000L
        update_room(room)
        trim_detached_terminals(runtime)
      }
      binding.wake.close()
    }
    // Append current state after the recorded backlog; older geometry must be
    // replayed before its bytes. No task can interleave this synchronous setup.
    update_room(room)
    let ready_at = lease.sequence
    @async.with_task_group() <| group => {
      group.spawn_bg(no_wait=true, () => {
        send_terminal_resume(peer, lease, binding, cursor, ready_at, resumed)
      })
      receive_terminal_resume(room, peer, lease, binding)
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
