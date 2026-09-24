///|
fn phase_plain(text : String) -> String {
  text
  .replace_all(old="**", new="")
  .replace_all(old="__", new="")
  .replace_all(old="`", new="")
  .trim()
  .to_owned()
}

///|
fn phase_field(text : String) -> String? {
  let plain = phase_plain(text)
  if plain.to_upper().has_prefix("PHASE:") {
    Some(plain[6:].trim().to_owned())
  } else {
    None
  }
}

///|
fn phase_heading(text : String) -> (Int, String)? {
  let rest = text.trim_start(chars="#")
  let level = text.length() - rest.length()
  if level < 1 || level > 6 || !(rest.has_prefix(" ") || rest.has_prefix("\t")) {
    return None
  }
  Some((level, rest.trim().trim_end(chars="#").trim().to_owned()))
}

///|
fn phase_from_spec(text : String) -> String {
  let declarations : Array[String] = []
  let mut comment = false
  let mut fence = ""
  let mut section = 0
  let mut waiting = false
  for raw in text.trim_start(chars="\uFEFF").split("\n") {
    let line = raw.trim().to_owned()
    if fence != "" {
      let unindented = raw.trim_start(chars=" ")
      if raw.length() - unindented.length() <= 3 &&
        !unindented.has_prefix("\t") &&
        line.has_prefix(fence) &&
        line.trim_start(chars=fence[:1]).is_empty() {
        fence = ""
      }
      continue
    }
    // Comment removal keeps token boundaries; fenced examples never change comment state.
    let parts : Array[String] = []
    let mut rest = raw
    while !rest.is_empty() {
      if comment {
        match rest.find("-->") {
          Some(end) => {
            rest = rest[end + 3:]
            comment = false
          }
          None => break
        }
      } else {
        match rest.find("<!--") {
          Some(start) => {
            parts.push(rest[:start].to_owned())
            parts.push(" ")
            rest = rest[start + 4:]
            comment = true
          }
          None => {
            parts.push(rest.to_owned())
            break
          }
        }
      }
    }
    let visible = parts.join("")
    let trimmed = visible.trim_start(chars=" ")
    if visible.length() - trimmed.length() > 3 || trimmed.has_prefix("\t") {
      continue
    }
    let line = trimmed.trim().to_owned()
    if line == "" || line.has_prefix(">") {
      continue
    }
    if line.has_prefix("```") || line.has_prefix("~~~") {
      let count = line.length() - line.trim_start(chars=line[:1]).length()
      fence = line[:count].to_owned()
      continue
    }
    if phase_heading(line) is Some((level, title)) {
      if level <= section {
        section = 0
        waiting = false
      }
      if title.to_upper() == "PHASE" {
        declarations.push("")
        section = level
        waiting = true
        continue
      }
    }
    if waiting {
      declarations[declarations.length() - 1] = phase_field(line).unwrap_or(
        line,
      )
      waiting = false
    } else if phase_field(line) is Some(value) {
      declarations.push(value)
    }
  }
  if declarations.length() != 1 {
    return "UNKNOWN"
  }
  let value = phase_plain(declarations[0]).to_upper()
  for name in ["PROTOTYPE", "ITERATE", "IMPLEMENT", "MAINTAIN"] {
    if value == name {
      return name
    }
    if value.has_prefix(name) {
      let suffix = value[name.length():]
      for delimiter in [" ", "\t", "\r", ".", ",", ":", ";", "("] {
        if suffix.has_prefix(delimiter) {
          return name
        }
      }
    }
  }
  "UNKNOWN"
}

///|
async fn has_claude(path : String) -> Bool {
  try
    @fs.exists(path + "/CLAUDE.md") && @fs.kind(path + "/CLAUDE.md") == Regular
  catch {
    _ => false
  }
}

///|
async fn project_phase(path : String) -> String? {
  if !has_claude(path) {
    return None
  }
  let phase = try {
    let source = safe_file(path, ".agent/spec.md")
    if @fs.kind(source) != Regular {
      fail("Phase spec is not a regular file")
    }
    let file = @fs.open(source, mode=ReadOnly)
    defer file.close()
    let size = file.size()
    if file.kind() != Regular || size < 0L || size > 1048576L {
      fail("Phase spec exceeds the read boundary")
    }
    // Read one extra byte to detect growth without an unbounded read_all.
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
      fail("Phase spec changed during the read")
    }
    phase_from_spec(
      @utf8.decode(buffer.unsafe_reinterpret_as_bytes()[:used].to_owned()),
    )
  } catch {
    _ => "UNKNOWN"
  }
  Some(phase)
}
