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
fn prompt_body(source : String, steered : Bool, bounded : Bool) -> String? {
  let mut body = prompt_start(source)
  if bounded {
    // Remove padding before a closing rule, preserving the last content line ending.
    let mut offset = 0
    let mut end = 0
    for line in body.split("\n") {
      offset += line.length() + 1
      if !line.trim().is_empty() {
        end = if offset > body.length() { body.length() } else { offset }
      }
    }
    body = body[:end].to_owned()
  }
  if steered {
    match body.split_once("\n") {
      Some((slot, rest)) if slot.trim() == "<request>" ||
        slot.trim() == "<rows>" => body = prompt_start(rest.to_owned())
      _ => return None
    }
  }
  if body.trim().is_empty() {
    return None
  }
  Some(body)
}

///|
fn parse_prompts(
  source : String,
  steered : Bool,
) -> Array[(String, String, String)] raise {
  let prompts : Array[(String, String, String)] = []
  let lines = source.split("\n").to_array()
  let heading = lines[0].trim().to_owned()
  if !heading.has_prefix("# ") || heading[2:].trim().is_empty() {
    return prompts
  }
  let title = heading[2:].trim().to_owned()
  let suffix = if steered { " (steered)" } else { " (automatic)" }
  let occurrences : Map[String, Int32] = Map([])
  let mut offset = 0
  let mut first_rule = true
  let mut fence = ""
  let mut pending : String? = None
  let mut section = ""
  let mut body_start : Int32? = None
  for raw in lines {
    let start = offset
    offset += raw.length() + 1
    let end = if offset > source.length() { source.length() } else { offset }
    let line = raw.trim().to_owned()
    let unindented = raw.trim_start(chars=" ")
    let indented = raw.length() - unindented.length() > 3 ||
      unindented.has_prefix("\t")
    if fence != "" {
      if !indented &&
        line.has_prefix(fence) &&
        line.trim_start(chars=fence[:1]).is_empty() {
        fence = ""
      }
      continue
    }
    if indented {
      if !line.is_empty() {
        pending = None
      }
      continue
    }
    if line.has_prefix("```") || line.has_prefix("~~~") {
      let count = line.length() - line.trim_start(chars=line[:1]).length()
      fence = line[:count].to_owned()
      pending = None
      continue
    }
    if line == "---" {
      if first_rule {
        first_rule = false
        if pending is None {
          if prompt_body(source[end:].to_owned(), steered, false) is Some(body) {
            prompts.push(("", title + suffix, body))
          }
          return prompts
        }
      }
      if body_start is Some(body_offset) {
        if !section.is_empty() &&
          prompt_body(source[body_offset:start].to_owned(), steered, true)
          is Some(body) {
          occurrences[section] = occurrences.get(section).unwrap_or(0) + 1
          prompts.push((section, title + ": " + section + suffix, body))
        }
        body_start = None
      } else if pending is Some(name) {
        section = name
        body_start = Some(end)
      }
      pending = None
    } else if !line.is_empty() {
      pending = if line == "##" ||
        line.has_prefix("## ") ||
        line.has_prefix("##\t") {
        Some(line[2:].trim().to_owned())
      } else {
        None
      }
    }
  }
  let duplicate_ids : Map[String, Int32] = Map([])
  for index = 0; index < prompts.length(); index = index + 1 {
    let (name, label, body) = prompts[index]
    let mut id = "/sections/" +
      name.replace_all(old="%", new="%25").replace_all(old="/", new="%2F")
    if occurrences.get(name).unwrap_or(0) > 1 {
      // Ambiguous names follow their content so reordering cannot swap steering drafts.
      id += "/body/" + @native.sha256(@utf8.encode(body))
      let occurrence = duplicate_ids.get(id).unwrap_or(0) + 1
      duplicate_ids[id] = occurrence
      if occurrence > 1 {
        id += "/" + occurrence.to_string()
      }
    }
    prompts[index] = (id, label, body)
  }
  prompts
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
          for
            (section_id, title, body) in parse_prompts(
              read_prompt(root, name),
              steered,
            ) {
            prompts.push({
              "id": Json(relative + "/" + name + section_id),
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
