///|
pub(all) struct Config {
  port : Int
  projectRoot : String
  dataRoot : String
  stateRoot : String
  runtimeRoot : String
  webRoot : String
  machineName : String
  allowedUsers : Array[String]
  allowedOrigins : Array[String]
  directUrl : String
  gatewayUrl : String
  gatewaySecret : String
  snapshotBackend : String
  shell : String
  mut machineId : String
} derive(ToJson)

///|
pub(all) struct Machine {
  id : String
  name : String
  version : String
  projectRoot : String
} derive(ToJson, @json.FromJson)

///|
pub(all) struct Feature {
  id : String
  title : String
  revision : String
  entry : String
  status : String
  updatedAt : Double
} derive(ToJson, @json.FromJson)

///|
pub(all) struct Diagnostic {
  feature : String
  message : String
  updatedAt : Double
} derive(ToJson, @json.FromJson)

///|
pub(all) struct Project {
  id : String
  name : String
  path : String
  mut features : Array[Feature]
  mut diagnostics : Array[Diagnostic]
} derive(ToJson, @json.FromJson)

///|
pub(all) struct State {
  protocol : Int
  machine : Machine
  projects : Array[Project]
} derive(ToJson, @json.FromJson)

///|
struct RegistryEntry {
  id : String
  path : String
  identity : String
} derive(ToJson, @json.FromJson)

///|
pub fn field(value : Json, name : String) -> Json {
  match value {
    Object(object) => object.get(name).unwrap_or(Json::null())
    _ => Json::null()
  }
}

///|
pub fn string_field(
  value : Json,
  name : String,
  fallback? : String = "",
) -> String {
  match field(value, name) {
    String(value) => value
    _ => fallback
  }
}

///|
pub fn int_field(value : Json, name : String, fallback? : Int = 0) -> Int {
  match field(value, name) {
    Number(value, ..) if value >= -2147483648.0 && value <= 2147483647.0 =>
      value.to_int()
    _ => fallback
  }
}

///|
pub fn string_array(value : Json) -> Array[String] raise {
  @json.from_json(value)
}

///|
pub fn valid_id(value : String) -> Bool {
  let bytes = @utf8.encode(value)
  if bytes.length() == 0 || bytes.length() > 48 || bytes[0] == 45 {
    return false
  }
  for byte in bytes {
    let n = byte.to_int()
    if !((n >= 97 && n <= 122) || (n >= 48 && n <= 57) || n == 45) {
      return false
    }
  }
  true
}

///|
pub fn safe_relative(value : String) -> Bool {
  if value.is_empty() || value.has_prefix("/") || value.contains("\\") {
    return false
  }
  for byte in @utf8.encode(value) {
    if byte.to_int() < 32 || byte == 127 {
      return false
    }
  }
  for segment in value.split("/") {
    if segment == "" || segment == "." || segment == ".." {
      return false
    }
  }
  true
}

///|
fn hex_value(byte : Byte) -> Int raise {
  let n = byte.to_int()
  if n >= 48 && n <= 57 {
    return n - 48
  }
  if n >= 65 && n <= 70 {
    return n - 55
  }
  if n >= 97 && n <= 102 {
    return n - 87
  }
  fail("Malformed URL escape")
}

///|
pub fn url_decode(value : String) -> String raise {
  let input = @utf8.encode(value)
  let output : Array[Byte] = []
  let mut i = 0
  while i < input.length() {
    if input[i] == 37 {
      if i + 2 >= input.length() {
        fail("Incomplete URL escape")
      }
      output.push(
        (hex_value(input[i + 1]) * 16 + hex_value(input[i + 2])).to_byte(),
      )
      i = i + 3
    } else {
      output.push(input[i])
      i = i + 1
    }
  }
  @utf8.decode(Bytes::from_array(output))
}

///|
pub fn parent(path : String) -> String {
  match path.rev_find("/") {
    Some(0) => "/"
    Some(index) => path[:index].to_owned()
    None => "."
  }
}

///|
pub fn basename(path : String) -> String {
  match path.rev_find("/") {
    Some(index) => path[index + 1:].to_owned()
    None => path
  }
}

///|
pub fn is_within(path : String, root : String) -> Bool {
  path == root || path.has_prefix(root + "/")
}

///|
pub async fn future_path(path : String) -> String {
  if !path.has_prefix("/") {
    fail("Configuration paths must be absolute")
  }
  if @fs.exists(path) {
    return @fs.realpath(path)
  }
  let name = basename(path)
  if !safe_relative(name) {
    fail("Invalid configuration path")
  }
  let base = future_path(parent(path))
  if base == "/" {
    "/" + name
  } else {
    base + "/" + name
  }
}

///|
pub async fn safe_file(root : String, relative : String) -> String {
  if !safe_relative(relative) {
    fail("Invalid relative path")
  }
  let base = @fs.realpath(root)
  let target = @fs.realpath(base + "/" + relative)
  if !is_within(target, base) {
    fail("Path escapes its owning directory")
  }
  target
}

///|
pub async fn ensure_dir(path : String) -> Unit {
  if @fs.exists(path) {
    if @fs.kind(path) != Directory {
      fail("Expected a directory: " + path)
    }
    return
  }
  @fs.mkdir(path, recursive=true, permission=448) catch {
    error => if !@fs.exists(path) || @fs.kind(path) != Directory { raise error }
  }
}

///|
pub async fn read_json(path : String) -> Json {
  let file = @fs.open(path, mode=ReadOnly)
  defer file.close()
  if file.size() > 8388608L {
    fail("JSON file exceeds the 8 MiB limit")
  }
  file.read_all().json()
}

///|
pub async fn atomic_json(path : String, value : Json) -> Unit {
  let temporary = parent(path) + "/.pending-" + @native.random_id()
  @fs.write_file(
    temporary,
    value.stringify(indent=2),
    create_mode=CreateNew,
    permission=384,
    sync=Full,
  )
  @fs.rename(temporary, path, replace=true)
  @native.sync_directory(parent(path))
}

///|
pub fn test_config(root : String) -> Config {
  {
    port: 4737,
    projectRoot: root + "/Projects",
    dataRoot: root + "/data",
    stateRoot: root + "/state",
    runtimeRoot: root + "/runtime",
    webRoot: root + "/web",
    machineName: "test-machine",
    allowedUsers: [],
    allowedOrigins: ["http://127.0.0.1:4737"],
    directUrl: "http://127.0.0.1:4737/",
    gatewayUrl: "",
    gatewaySecret: "",
    snapshotBackend: "copy",
    shell: "/bin/bash",
    machineId: "",
  }
}

///|
fn expand(path : String, home : String) -> String {
  if path == "~" {
    home
  } else if path.has_prefix("~/") {
    home + path[1:].to_owned()
  } else {
    path
  }
}

///|
pub async fn load_config() -> Config {
  let home = @env.get_env_var("HOME").unwrap_or("/nonexistent")
  let config_home = @env.get_env_var("XDG_CONFIG_HOME").unwrap_or(
    home + "/.config",
  )
  let path = @env.get_env_var("EMACHINE_CONFIG").unwrap_or(
    config_home + "/emachine/config.json",
  )
  let raw = if @fs.exists(path) {
    read_json(path)
  } else {
    Json::empty_object()
  }
  let port = int_field(raw, "port", fallback=4737)
  if port < 1024 || port > 65535 {
    fail("port must be between 1024 and 65535")
  }
  fn configured_path(key : String, fallback : String) -> String {
    expand(string_field(raw, key, fallback~), home)
  }
  let state = configured_path(
    "stateRoot",
    @env.get_env_var("XDG_STATE_HOME").unwrap_or(home + "/.local/state") +
    "/emachine",
  )
  let origins = match field(raw, "allowedOrigins") {
    Null =>
      ["http://127.0.0.1:\{port}", "http://localhost:\{port}", "emachine://app"]
    value => string_array(value)
  }
  let users = match field(raw, "allowedUsers") {
    Null => []
    value => string_array(value)
  }
  {
    port,
    projectRoot: configured_path("projectRoot", home + "/Projects"),
    dataRoot: configured_path(
      "dataRoot",
      @env.get_env_var("XDG_DATA_HOME").unwrap_or(home + "/.local/share") +
      "/emachine",
    ),
    stateRoot: state,
    runtimeRoot: configured_path(
      "runtimeRoot",
      @env.get_env_var("XDG_RUNTIME_DIR").unwrap_or(state) + "/emachine-runtime",
    ),
    webRoot: configured_path("webRoot", home + "/.local/app/emachine/web/dist"),
    machineName: string_field(raw, "machineName", fallback=@native.hostname()),
    allowedUsers: users,
    allowedOrigins: origins,
    directUrl: string_field(
      raw,
      "directUrl",
      fallback="http://127.0.0.1:\{port}/",
    ),
    gatewayUrl: string_field(raw, "gatewayUrl"),
    gatewaySecret: string_field(raw, "gatewaySecret"),
    snapshotBackend: string_field(raw, "snapshotBackend", fallback="copy"),
    shell: string_field(
      raw,
      "shell",
      fallback=@env.get_env_var("SHELL").unwrap_or("/bin/bash"),
    ),
    machineId: "",
  }
}

///|
pub async fn initialize(config : Config) -> Unit {
  let projects = future_path(config.projectRoot)
  for path in [config.dataRoot, config.stateRoot, config.runtimeRoot] {
    let target = future_path(path)
    if is_within(target, projects) || is_within(projects, target) {
      fail("Emachine storage must be disjoint from the managed project root")
    }
  }
  for path in [config.dataRoot, config.stateRoot, config.runtimeRoot] {
    ensure_dir(path)
    @fs.chmod(path, 448)
  }
  let lock = @fs.open(
    config.stateRoot + "/registry.lock",
    mode=ReadWrite,
    create_mode=OpenOrCreate,
    permission=384,
  )
  defer lock.close()
  lock.lock(Exclusive)
  let id_path = config.stateRoot + "/machine.json"
  if !@fs.exists(id_path) {
    atomic_json(id_path, { "id": @native.random_id().to_json() })
  }
  config.machineId = string_field(read_json(id_path), "id")
  if !valid_id(config.machineId) {
    fail("Stored machine identity is invalid")
  }
}

///|
pub fn machine(config : Config) -> Machine {
  {
    id: config.machineId,
    name: config.machineName,
    version: "0.1.0",
    projectRoot: config.projectRoot,
  }
}

///|
pub async fn discover(config : Config) -> Array[Project] {
  let lock = @fs.open(
    config.stateRoot + "/registry.lock",
    mode=ReadWrite,
    create_mode=OpenOrCreate,
    permission=384,
  )
  defer lock.close()
  lock.lock(Exclusive)
  let registry_path = config.stateRoot + "/registry.json"
  let registry : Array[RegistryEntry] = if @fs.exists(registry_path) {
    @json.from_json(read_json(registry_path))
  } else {
    []
  }
  let result : Array[Project] = []
  if !@fs.exists(config.projectRoot) {
    return result
  }
  let names = @fs.readdir(config.projectRoot, sort=true)
  let mut changed = false
  for name in names {
    let candidate = config.projectRoot + "/" + name
    if @fs.kind(candidate) != Directory {
      continue
    }
    let path = @fs.realpath(candidate)
    if result.any(p => p.path == path) {
      continue
    }
    let identity = @native.file_identity(path)
    let found = registry.search_by(entry => {
      entry.path == path || entry.identity == identity
    })
    let id = match found {
      Some(index) => {
        let old = registry[index]
        if old.path != path || old.identity != identity {
          registry[index] = { id: old.id, path, identity, }
          changed = true
        }
        old.id
      }
      None => {
        let id = @native.random_id()
        registry.push({ id, path, identity, })
        changed = true
        id
      }
    }
    result.push({ id, name, path, features: [], diagnostics: [], })
  }
  if changed {
    atomic_json(registry_path, registry.to_json())
  }
  result
}

///|
pub async fn resolve_project(config : Config, name_or_id : String) -> Project {
  let projects = discover(config)
  let matches = projects.filter(p => {
    p.id == name_or_id || p.name == name_or_id || p.path == name_or_id
  })
  if matches.length() != 1 {
    fail("Project must resolve to exactly one local directory: \{name_or_id}")
  }
  matches[0]
}

///|
pub fn project_data(config : Config, project : String) -> String raise {
  if !valid_id(project) {
    fail("Invalid project identity")
  }
  config.dataRoot + "/projects/" + project
}

///|
pub fn feature_data(
  config : Config,
  project : String,
  feature : String,
) -> String raise {
  if !valid_id(feature) {
    fail("Invalid feature identity")
  }
  project_data(config, project) + "/features/" + feature
}

///|
pub fn content_type(path : String) -> String {
  if path.has_suffix(".html") {
    "text/html; charset=utf-8"
  } else if path.has_suffix(".js") || path.has_suffix(".mjs") {
    "text/javascript; charset=utf-8"
  } else if path.has_suffix(".css") {
    "text/css; charset=utf-8"
  } else if path.has_suffix(".json") || path.has_suffix(".webmanifest") {
    "application/json; charset=utf-8"
  } else if path.has_suffix(".svg") {
    "image/svg+xml"
  } else if path.has_suffix(".png") {
    "image/png"
  } else if path.has_suffix(".jpg") || path.has_suffix(".jpeg") {
    "image/jpeg"
  } else if path.has_suffix(".webp") {
    "image/webp"
  } else if path.has_suffix(".woff2") {
    "font/woff2"
  } else if path.has_suffix(".wasm") {
    "application/wasm"
  } else if path.has_suffix(".pdf") {
    "application/pdf"
  } else if path.has_suffix(".txt") || path.has_suffix(".md") {
    "text/plain; charset=utf-8"
  } else {
    "application/octet-stream"
  }
}
