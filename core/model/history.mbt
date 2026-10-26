///|
priv struct HistoryRead {
  project : String
  root : String
  matches : Map[String, Bool]
  pastes : Map[String, String?]
  mut paste_reads : Int32
}

///|
fn history_decimal(value : String) -> Int64? {
  if value.is_empty() || value.length() > 16 {
    return None
  }
  let mut result = 0L
  for byte in @utf8.encode(value) {
    if byte < b'0' || byte > b'9' {
      return None
    }
    result = result * 10L + (byte.to_int() - 48).to_int64()
    if result > 9007199254740991L {
      return None
    }
  }
  Some(result)
}

///|
async fn history_cursor(
  file : @fs.File,
  identity : String,
  project : String,
  snapshot : Int64,
  position : Int64,
  partial : Bool,
) -> String {
  let count = if position > 256L { 256 } else { position.to_int() }
  let head = file.read_exactly_at(count, position=0L)
  let anchor = file.read_exactly_at(count, position=position - count.to_int64())
  let tail_count = if snapshot > 256L { 256 } else { snapshot.to_int() }
  let tail = file.read_exactly_at(
    tail_count,
    position=snapshot - tail_count.to_int64(),
  )
  let tag = @native.sha256(
    @utf8.encode(
      project +
      "\n" +
      identity +
      "\n" +
      snapshot.to_string() +
      "\n" +
      @native.sha256(head) +
      "\n" +
      @native.sha256(anchor) +
      "\n" +
      @native.sha256(tail),
    ),
  )
  "1." +
  snapshot.to_string() +
  "." +
  position.to_string() +
  "." +
  (if partial { "1" } else { "0" }) +
  "." +
  tag
}

///|
async fn history_matches(read : HistoryRead, path : String) -> Bool {
  if read.matches.get(path) is Some(result) {
    return result
  }
  let result = try {
    if !path.has_prefix("/") ||
      path.length() > 4096 ||
      @utf8.encode(path).iter().any(byte => byte < 32 || byte == 127) {
      false
    } else {
      is_within(future_path(path), read.project)
    }
  } catch {
    error => {
      if @async.is_being_cancelled() {
        raise error
      }
      false
    }
  }
  read.matches[path] = result
  result
}

///|
async fn history_paste(read : HistoryRead, value : Json) -> String? {
  if string_field(value, "type") != "text" {
    return None
  }
  if field(value, "content") is String(content) {
    return Some(content)
  }
  let hash = string_field(value, "contentHash")
  if (hash.length() != 16 && hash.length() != 64) ||
    !@utf8.encode(hash)
    .iter()
    .all(byte => {
      (byte >= b'0' && byte <= b'9') || (byte >= b'a' && byte <= b'f')
    }) {
    return None
  }
  if read.pastes.get(hash) is Some(content) {
    return content
  }
  if read.paste_reads >= 64 {
    return None
  }
  read.paste_reads += 1
  let content = try {
    let cache = safe_file(read.root, "paste-cache")
    let path = safe_file(cache, hash + ".txt")
    if @fs.kind(path) != Regular {
      None
    } else {
      let file = @fs.open(path, mode=ReadOnly)
      defer file.close()
      let size = file.size()
      if file.kind() != Regular || size < 0L || size > 1048576L {
        None
      } else {
        Some(@utf8.decode(file.read_exactly_at(size.to_int(), position=0L)))
      }
    }
  } catch {
    error => {
      if @async.is_being_cancelled() {
        raise error
      }
      None
    }
  }
  read.pastes[hash] = content
  content
}

///|
async fn history_body(
  read : HistoryRead,
  value : Json,
  display : String,
) -> (String, Bool) {
  let parts : Array[String] = []
  let pasted = field(value, "pastedContents")
  let mut offset = 0
  let mut incomplete = false
  let mut bytes = @utf8.encode(display).length()
  let mut markers = 0
  // Inspect the original display only; inserted text may itself contain examples.
  while offset < display.length() {
    guard display[offset:].find("[Pasted text #") is Some(relative) else {
      parts.push(display[offset:].to_owned())
      break
    }
    let start = offset + relative
    parts.push(display[offset:start].to_owned())
    guard display[start:].find("]") is Some(close) else {
      parts.push(display[start:].to_owned())
      break
    }
    let end = start + close + 1
    let marker = display[start:end].to_owned()
    let label = display[start + 14:end - 1].to_owned()
    let id = match label.split_once(" +") {
      Some((id, lines)) =>
        if (
            lines.has_suffix(" lines") &&
            history_decimal(lines[:lines.length() - 6].to_owned()) is Some(_)
          ) ||
          (
            lines.has_suffix(" line") &&
            history_decimal(lines[:lines.length() - 5].to_owned()) is Some(_)
          ) {
          id.to_owned()
        } else {
          ""
        }
      None => label
    }
    let replacement = if history_decimal(id) is Some(_) && markers < 128 {
      markers += 1
      history_paste(read, field(pasted, id))
    } else {
      None
    }
    match replacement {
      Some(content) => {
        let next_size = bytes -
          @utf8.encode(marker).length() +
          @utf8.encode(content).length()
        if next_size <= 1048576 {
          parts.push(content)
          bytes = next_size
        } else {
          parts.push(marker)
          incomplete = true
        }
      }
      None => {
        parts.push(marker)
        incomplete = true
      }
    }
    offset = end
  }
  (parts.join(""), incomplete)
}

///|
async fn history_entry(
  read : HistoryRead,
  bytes : BytesView,
  id : String,
) -> Json? {
  if bytes.length() == 0 || bytes.length() > 1048576 {
    return None
  }
  try {
    let value = @json.parse(
      @utf8.decode(bytes.to_owned()),
      max_nesting_depth=32,
    )
    let display = string_field(value, "display")
    if display.trim().is_empty() {
      return None
    }
    guard field(value, "timestamp") is Number(timestamp, ..) &&
      timestamp >= 0.0 &&
      timestamp <= 8640000000000000.0 &&
      timestamp.to_int64().to_double() == timestamp else {
      return None
    }
    if !history_matches(read, string_field(value, "project")) {
      return None
    }
    let (body, incomplete) = history_body(read, value, display)
    if body.trim().is_empty() {
      return None
    }
    Some({
      "id": id.to_json(),
      "body": body.to_json(),
      "timestamp": timestamp.to_json(),
      "incomplete": incomplete.to_json(),
    })
  } catch {
    error => {
      if @async.is_being_cancelled() {
        raise error
      }
      None
    }
  }
}

///|
pub async fn prompt_history(
  config : Config,
  project_id : String,
  cursor : String,
) -> Json {
  let project = resolve_project(config, project_id)
  let root = @env.get_env_var("CLAUDE_CONFIG_DIR").unwrap_or(
    @env.get_env_var("HOME").unwrap_or("/nonexistent") + "/.claude",
  )
  if !@fs.exists(root + "/history.jsonl") {
    if !cursor.is_empty() {
      fail("Prompt history changed. Reload history.")
    }
    return { "prompts": [], "nextCursor": Json::null() }
  }
  let path = safe_file(root, "history.jsonl")
  if @fs.kind(path) != Regular {
    fail("Prompt history is not a regular file")
  }
  let file = @fs.open(path, mode=ReadOnly)
  defer file.close()
  if file.kind() != Regular {
    fail("Prompt history is not a regular file")
  }
  let size = file.size()
  let identity = @native.file_identity(path)
  let mut snapshot = size
  let mut position = size
  let mut partial = false
  if !cursor.is_empty() {
    match cursor.split(".").to_array() {
      ["1", raw_snapshot, raw_position, flag, tag] if (
          flag == "0" || flag == "1"
        ) &&
        tag.length() == 64 => {
        guard history_decimal(raw_snapshot.to_owned()) is Some(saved_size) &&
          saved_size <= size else {
          fail("Prompt history changed. Reload history.")
        }
        guard history_decimal(raw_position.to_owned()) is Some(offset) &&
          offset > 0L &&
          offset <= saved_size else {
          fail("Invalid or stale prompt history cursor. Reload history.")
        }
        snapshot = saved_size
        position = offset
        partial = flag == "1"
      }
      _ => fail("Invalid prompt history cursor")
    }
  }
  let checkpoint = history_cursor(
    file,
    identity,
    project.path,
    snapshot,
    position,
    partial,
  )
  if !cursor.is_empty() && checkpoint != cursor {
    fail("Prompt history changed. Reload history.")
  }
  let start = if position > 2097152L { position - 2097152L } else { 0L }
  let bytes = file.read_exactly_at((position - start).to_int(), position=start)
  let read : HistoryRead = {
    project: project.path,
    root,
    matches: {},
    pastes: {},
    paste_reads: 0,
  }
  let prompts : Array[Json] = []
  let mut body_bytes = 0
  let mut end = bytes.length()
  let mut next_position = position
  let mut next_partial = partial
  let mut lines = 0
  let mut stopped = false
  // Reverse complete byte-delimited lines before decoding UTF-8. Keep an
  // unfinished left edge for the next page instead of losing a chunk boundary.
  for index = bytes.length() - 1; index >= -1; index = index - 1 {
    if index >= 0 && bytes[index] != b'\n' {
      continue
    }
    if index == -1 && start > 0L {
      if next_position == position {
        next_position = start
        next_partial = true
      }
      break
    }
    let line_start = index + 1
    if !next_partial {
      let entry_id = @native.sha256(
        @utf8.encode(
          identity + "\n" + (start + line_start.to_int64()).to_string(),
        ),
      )
      if history_entry(read, bytes[line_start:end], entry_id) is Some(entry) {
        let count = @utf8.encode(string_field(entry, "body")).length()
        if body_bytes + count > 2097152 && !prompts.is_empty() {
          stopped = true
          break
        }
        prompts.push(entry)
        body_bytes += count
      }
    }
    next_partial = false
    next_position = start + line_start.to_int64()
    end = index
    lines += 1
    if prompts.length() >= 50 || lines >= 2000 {
      stopped = true
      break
    }
  }
  if start == 0L && !stopped {
    next_position = 0L
    next_partial = false
  }
  if file.size() < snapshot ||
    @native.file_identity(path) != identity ||
    history_cursor(file, identity, project.path, snapshot, position, partial) !=
    checkpoint {
    fail("Prompt history changed. Reload history.")
  }
  let next : Json = if next_position > 0L {
    history_cursor(
      file,
      identity,
      project.path,
      snapshot,
      next_position,
      next_partial,
    ).to_json()
  } else {
    Json::null()
  }
  { "prompts": prompts.to_json(), "nextCursor": next }
}
