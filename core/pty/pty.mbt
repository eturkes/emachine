///|
pub struct Pty {
  priv inner : @system_pty.Pty
  priv lifetime : @async.Task[Int]
  priv mut closed : Bool
  priv session : String
  priv environment : Map[String, String]
  priv probe_lock : @async.Mutex
  priv mut next_probe_at : Int64
  priv mut probe_interval : Int
  priv mut screen_identity : (Int, String)?
}

///|
pub async fn[G] spawn(
  group : @async.TaskGroup[G],
  cwd : String,
  session : String,
  shell : String,
  cols : Int,
  rows : Int,
  extra_env? : Map[String, String] = {},
) -> Pty {
  if cols < 2 || cols > 500 || rows < 2 || rows > 500 {
    fail("Terminal dimensions must be between 2 and 500")
  }
  let environment = @env.get_env_vars()
  environment.remove("ZMX_SESSION")
  environment.remove("ZMX_SESSION_PREFIX")
  for k, v in extra_env {
    environment[k] = v
  }
  environment["TERM"] = "xterm-256color"
  environment["COLORTERM"] = "truecolor"
  let ready : @async.Queue[@system_pty.Pty] = @async.Queue(kind=Blocking(1))
  let lifetime = group.spawn(no_wait=true, allow_failure=true, () => {
    (@async.with_task_group() <| inner_group => {
      let terminal = @system_pty.spawn(
        inner_group,
        rows~,
        cols~,
        "zmx",
        ["attach", session[:], shell[:], "-l"],
        cwd=cwd[:],
        extra_env=environment,
        inherit_env=false,
        no_wait=true,
      )
      ready.put(terminal)
      terminal.wait()
    }) catch {
      error => {
        ready.close(error~)
        raise error
      }
    }
  })
  let inner = ready.get()
  {
    inner,
    lifetime,
    closed: false,
    session,
    environment,
    probe_lock: @async.Mutex(),
    next_probe_at: 0L,
    probe_interval: 1000,
    screen_identity: None,
  }
}

///|
pub async fn Pty::read(self : Pty) -> Bytes {
  let data = self.inner.read_some(max_len=16384).unwrap_or(b"")
  // Probe after output exists: startup queries must not depend on discovering a session first.
  if !data.is_empty() {
    self.refresh_screen()
  }
  data
}

///|
pub async fn Pty::refresh_screen(self : Pty) -> Unit {
  if self.closed || self.screen_identity is Some(_) {
    return
  }
  self.probe_lock.acquire()
  defer self.probe_lock.release()
  let now = @native.now_ms()
  if self.closed || self.screen_identity is Some(_) || now < self.next_probe_at {
    return
  }
  self.next_probe_at = now + self.probe_interval.to_int64()
  self.probe_interval = if self.probe_interval >= 15000 {
    30000
  } else {
    self.probe_interval * 2
  }
  self.screen_identity = session_identity(self.session, self.environment)
}

///|
fn session_pid(output : String, session : String) -> Int? {
  let prefix = "name=" + session + "\tpid="
  let mut found : Int? = None
  for raw_line in output.split("\n") {
    let line = raw_line.trim_start()
    if !line.has_prefix(prefix) {
      continue
    }
    guard line[prefix.length():].split_once("\t") is Some((number, _)) else {
      return None
    }
    if found is Some(_) || number.is_empty() || number.length() > 10 {
      return None
    }
    let mut pid = 0L
    for byte in @utf8.encode(number) {
      if byte < 48 || byte > 57 {
        return None
      }
      pid = pid * 10L + (byte.to_int() - 48).to_int64()
      if pid > 2147483647L {
        return None
      }
    }
    if pid <= 1L {
      return None
    }
    found = Some(pid.to_int())
  }
  found
}

///|
async fn session_identity(
  session : String,
  environment : Map[String, String],
) -> (Int, String)? {
  // Listing is optional metadata; never let a stale zmx socket delay terminal output indefinitely.
  if session.contains("\n") || session.contains("\r") || session.contains("\t") {
    return None
  }
  @async.with_timeout(150, () => {
    @async.with_task_group() <| group => {
      let (reader, output) = @process.read_from_process()
      defer reader.close()
      let child = @process.spawn(
        group,
        "zmx",
        ["list"],
        extra_env=environment,
        inherit_env=false,
        stdout=output,
        stderr=output,
        cancel_handler=@process.hard_cancel(),
        no_wait=true,
      )
      let mut bytes = b""
      for ;; {
        let chunk = reader.read_some(max_len=8192).unwrap_or(b"")
        if chunk.is_empty() {
          break
        }
        if bytes.length() + chunk.length() > 1048576 {
          fail("Session listing exceeds its metadata boundary")
        }
        bytes = bytes + chunk
      }
      if child.wait() != 0 {
        return None
      }
      guard session_pid(@utf8.decode(bytes), session) is Some(pid) else {
        return None
      }
      @native.session_pty_identity(pid).map(identity => (pid, identity))
    }
  }) catch {
    error => {
      if @async.is_being_cancelled() {
        raise error
      }
      None
    }
  }
}

///|
pub fn Pty::screen_size(self : Pty) -> (Int, Int)? {
  if self.closed {
    return None
  }
  match self.screen_identity {
    Some((pid, identity)) => @native.session_pty_size(pid, identity)
    None => None
  }
}

///|
pub async fn Pty::write(self : Pty, data : Bytes) -> Unit {
  if self.closed {
    fail("Terminal attachment is closed")
  }
  self.inner.write(data)
}

///|
pub fn Pty::resize(self : Pty, cols : Int, rows : Int) -> Unit raise {
  if self.closed {
    fail("Terminal attachment is closed")
  }
  if cols < 2 || cols > 500 || rows < 2 || rows > 500 {
    fail("Invalid terminal dimensions")
  }
  self.inner.resize(rows~, cols~)
}

///|
pub fn Pty::close(self : Pty) -> Unit {
  if !self.closed {
    self.closed = true
    self.lifetime.cancel()
  }
}

///|
pub async fn Pty::wait(self : Pty) -> Int {
  self.lifetime.wait() catch {
    error if @async.is_cancellation_error(error) && self.closed => 0
    error => raise error
  }
}
