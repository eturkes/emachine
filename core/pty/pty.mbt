///|
pub struct Pty {
  priv inner : @system_pty.Pty
  priv lifetime : @async.Task[Int]
  priv mut closed : Bool
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
  { inner, lifetime, closed: false, }
}

///|
pub async fn Pty::read(self : Pty) -> Bytes {
  self.inner.read_some(max_len=16384).unwrap_or(b"")
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
