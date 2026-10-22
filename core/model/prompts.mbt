///|
fn prompt_start(source : String) -> String {
  let mut offset = 0
  for line in source.split("\n") {
    if !line.trim().is_empty() {
      break
    }
    offset += line.length() + 1
  }
  if offset >= source.length() {
    ""
  } else {
    source[offset:].to_owned()
  }
}

///|
fn parse_prompt(source : String, steered : Bool) -> (String, String)? {
  let lines = source.split("\n").to_array()
  let heading = lines[0].trim().to_owned()
  if !heading.has_prefix("# ") {
    return None
  }
  let title = heading[2:].trim().to_owned()
  if title.is_empty() {
    return None
  }
  let mut offset = 0
  let mut found = false
  for line in lines {
    offset += line.length() + 1
    if line.trim() == "---" {
      found = true
      break
    }
  }
  if !found || offset >= source.length() {
    return None
  }
  // Slice the source so body indentation and line endings survive header removal.
  let mut body = prompt_start(source[offset:].to_owned())
  if steered {
    match body.split_once("\n") {
      Some((slot, rest)) if slot.trim() == "<request>" =>
        body = prompt_start(rest.to_owned())
      _ => return None
    }
  }
  if body.trim().is_empty() {
    return None
  }
  let suffix = if steered { " (steered)" } else { " (automatic)" }
  Some((title + suffix, body))
}

///|
async fn read_prompt(root : String, name : String) -> String {
  let source = safe_file(root, name)
  if @fs.kind(source) != Regular {
    fail("Prompt is not a regular file")
  }
  let file = @fs.open(source, mode=ReadOnly)
  defer file.close()
  let size = file.size()
  if file.kind() != Regular || size < 0L || size > 1048576L {
    fail("Prompt exceeds the read boundary")
  }
  let buffer = FixedArray::make(size.to_int() + 1, b'\x00')
  let mut used = 0
  while used < buffer.length() {
    let count = file.read(buffer, offset=used, max_len=buffer.length() - used)
    if count == 0 {
      break
    }
    used += count
  }
  if used != size.to_int() {
    fail("Prompt changed during the read")
  }
  @utf8.decode(buffer.unsafe_reinterpret_as_bytes()[:used].to_owned())
}

///|
pub async fn prompt_catalog() -> Json {
  let prompts : Array[Json] = []
  let home = @env.get_env_var("HOME").unwrap_or("/nonexistent")
  let agents = home + "/.local/app/agents"
  for variant in ["auto", "steered"] {
    try {
      let relative = "claude/prompts/" + variant
      let root = safe_file(agents, relative)
      if @fs.kind(root) != Directory {
        continue
      }
      let names = @fs.readdir(root)
      names.sort_by(String::lexical_compare)
      for name in names {
        if !name.has_suffix(".md") || name.to_lower() == "readme.md" {
          continue
        }
        try {
          let steered = variant == "steered"
          if parse_prompt(read_prompt(root, name), steered)
            is Some((title, body)) {
            prompts.push({
              "id": Json(relative + "/" + name),
              "title": Json(title),
              "body": Json(body),
              "steered": Json(steered),
            })
          }
        } catch {
          error => if @async.is_being_cancelled() { raise error }
        }
      }
    } catch {
      error => if @async.is_being_cancelled() { raise error }
    }
  }
  { "prompts": Json(prompts) }
}
