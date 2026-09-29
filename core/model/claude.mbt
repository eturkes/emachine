///|
priv struct ClaudeSession {
  path : String
  status : String
}

///|
fn claude_status(value : String) -> String? {
  match value {
    "busy" => Some("working")
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
  if pid <= 1 ||
    name != "\{pid}.json" ||
    field(value, "pid") != pid.to_json() ||
    string_field(value, "kind") != "interactive" ||
    string_field(value, "sessionId").is_empty() {
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
  Some({ path: @fs.realpath(cwd), status, })
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
  } catch {
    error => if @async.is_being_cancelled() { raise error }
  }
  result
}

///|
fn project_claude_status(
  path : String,
  sessions : Array[ClaudeSession],
) -> String? {
  let mut status : String? = None
  for session in sessions {
    if !is_within(session.path, path) {
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
