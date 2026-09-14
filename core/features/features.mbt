///|
pub(all) struct Manifest {
  id : String
  title : String
  entry : String
  output : String
  build : Array[String]
  refresh : String
  watch : Array[String]
  actions : Map[String, Array[String]]
  buildTimeoutMs : Int
} derive(ToJson, @json.FromJson)

///|
pub(all) struct Receipt {
  feature : @model.Feature
  manifest : Manifest
  inputs : String
} derive(ToJson, @json.FromJson)

///|
fn arguments(raw : Json, key : String) -> Array[String] raise {
  match @model.field(raw, key) {
    Null => []
    value => @json.from_json(value)
  }
}

///|
fn validate_argv(argv : Array[String]) -> Unit raise {
  for arg in argv { if arg.contains_char('\u0000') { fail("Command arguments cannot contain NUL") } }
  if !argv.is_empty() && argv[0].is_empty() { fail("Command executable cannot be empty") }
}

///|
pub fn parse_manifest(raw : Json) -> Manifest raise {
  let id = @model.string_field(raw, "id")
  let title = @model.string_field(raw, "title")
  let entry = @model.string_field(raw, "entry", fallback="index.html")
  let output = @model.string_field(raw, "output", fallback=".")
  let build = arguments(raw, "build")
  let watch = arguments(raw, "watch")
  let refresh = @model.string_field(raw, "refresh", fallback="manual")
  let actions : Map[String, Array[String]] = match @model.field(raw, "actions") {
    Null => {}
    value => @json.from_json(value)
  }
  let timeout = @model.int_field(raw, "buildTimeoutMs", fallback=120000)
  if !@model.valid_id(id) || title.is_empty() || title.length() > 160 { fail("Invalid feature id or title") }
  if !@model.safe_relative(entry) || (output != "." && !@model.safe_relative(output)) {
    fail("Feature output and entry must stay inside the workspace")
  }
  if refresh != "manual" && refresh != "automatic" { fail("refresh must be manual or automatic") }
  if timeout < 1000 || timeout > 3600000 { fail("buildTimeoutMs must be between 1000 and 3600000") }
  validate_argv(build)
  for item in watch { if item != "." && !@model.safe_relative(item) { fail("Invalid watched project path") } }
  for action, argv in actions {
    if !@model.valid_id(action) || argv.is_empty() { fail("Invalid feature action") }
    validate_argv(argv)
  }
  if refresh == "automatic" && actions.get("analyze") is None { fail("Automatic refresh requires an analyze action") }
  { id, title, entry, output, build, refresh, watch, actions, buildTimeoutMs: timeout }
}

///|
pub async fn lock_project(config : @model.Config, id : String) -> @fs.File {
  let base = @model.project_data(config, id)
  @model.ensure_dir(base)
  let lock = @fs.open(base + "/change.lock", mode=ReadWrite, create_mode=OpenOrCreate, permission=384)
  errdefer lock.close()
  lock.lock(Exclusive)
  lock
}

///|
pub async fn active(config : @model.Config, project : String) -> Array[Receipt] {
  let path = @model.project_data(config, project) + "/current.json"
  if @fs.exists(path) { @json.from_json(@model.read_json(path)) } else { [] }
}

///|
pub async fn get_active(config : @model.Config, project : String, feature : String) -> Receipt {
  let records = active(config, project)
  match records.search_by(record => record.feature.id == feature) {
    Some(index) => records[index]
    None => fail("The feature is not active for this project")
  }
}

///|
pub fn state_path(config : @model.Config, project : String, feature : String) -> String raise {
  if !@model.valid_id(project) || !@model.valid_id(feature) { fail("Invalid workspace identity") }
  config.stateRoot + "/projects/" + project + "/" + feature
}

///|
pub async fn tail_text(path : String, maximum? : Int = 65536) -> String {
  if !@fs.exists(path) { return "" }
  let file = @fs.open(path, mode=ReadOnly)
  defer file.close()
  let size = file.size()
  let count = if size > maximum.to_int64() { maximum } else { size.to_int() }
  let data = file.read_exactly_at(count, position=size - count.to_int64())
  @utf8.decode_lossy(data)
}

///|
async fn copy_directory(source : String, destination : String) -> Unit {
  @model.ensure_dir(destination)
  let (code, _, error) = @process.collect_output("cp", ["-a", "--reflink=auto", "--", source + "/.", destination])
  if code != 0 { fail("Copy failed: " + error.text()) }
}

///|
async fn package_digest(root : String, manifest : Manifest) -> String {
  let lines : Array[String] = [manifest.to_json().stringify()]
  let mut count = 0
  let mut total = 0L
  async fn visit(path : String, relative : String) -> Unit {
    for name in @fs.readdir(path, include_hidden=true, sort=true) {
      if name == ".git" || name == "node_modules" { fail("Publish a build output directory, not .git or node_modules") }
      let child = path + "/" + name
      let rel = if relative.is_empty() { name } else { relative + "/" + name }
      if !@model.safe_relative(rel) { fail("Invalid package file name") }
      match @fs.kind(child, follow_symlink=false) {
        Directory => visit(child, rel)
        Regular => {
          let file = @fs.open(child, mode=ReadOnly)
          defer file.close()
          let size = file.size()
          total = total + size
          count = count + 1
          if size > 67108864L || total > 536870912L || count > 10000 {
            fail("Feature package exceeds file or total size limits")
          }
          lines.push(rel + " " + @native.sha256(file.read_all().binary()))
        }
        _ => fail("Feature packages contain regular files and directories only; symlinks are not published")
      }
    }
  }
  visit(root, "")
  @native.sha256(@utf8.encode(lines.join("\n")))
}

///|
pub async fn fingerprint(project : @model.Project, manifest : Manifest) -> String {
  let lines : Array[String] = []
  let mut count = 0
  async fn visit(path : String, label : String) -> Unit {
    if !@fs.exists(path) { lines.push(label + ":missing"); return }
    let kind = @fs.kind(path, follow_symlink=false)
    if kind == SymLink { lines.push(label + ":symlink"); return }
    if kind == Directory {
      for name in @fs.readdir(path, include_hidden=true, sort=true) {
        if name == ".git" || name == "node_modules" || name == ".venv" || name == "__pycache__" || name == "_build" { continue }
        visit(path + "/" + name, label + "/" + name)
      }
    } else if kind == Regular {
      count = count + 1
      if count > 20000 { fail("Watch is too broad; select narrower project paths") }
      let (sec, ns) = @fs.mtime(path)
      let file = @fs.open(path, mode=ReadOnly)
      defer file.close()
      lines.push("\{label}:\{sec}:\{ns}:\{file.size()}")
    }
  }
  for item in manifest.watch {
    if item == "." { visit(project.path, ".") }
    else { visit(project.path + "/" + item, item) }
  }
  @native.sha256(@utf8.encode(lines.join("\n")))
}

///|
pub async fn create(config : @model.Config, project : @model.Project, id : String, title : String) -> String {
  let manifest = parse_manifest({"id": id.to_json(), "title": title.to_json(), "entry": "index.html"})
  let lock = lock_project(config, project.id)
  defer lock.close()
  let base = @model.feature_data(config, project.id, id)
  let workspace = base + "/workspace"
  if @fs.exists(workspace) { fail("The feature workspace already exists: " + workspace) }
  @model.ensure_dir(workspace)
  @model.atomic_json(workspace + "/feature.json", manifest.to_json())
  let html =
    #|<!doctype html>
    #|<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    #|<title>Project view</title>
    #|<style>:root{color-scheme:dark light;font:16px system-ui;background:#101820;color:#e6eeeb}body{margin:0;padding:32px}h1{font-size:28px}p{color:#a1b5ae;max-width:55ch;line-height:1.6}</style>
    #|<h1 id="title">Project view</h1><p id="project"></p><p>This workspace is ready for a project-specific implementation. Ask Codexify to edit this feature.</p>
    #|<script>addEventListener('message',e=>{if(e.source!==parent||e.data?.type!=='emachine:context')return;document.querySelector('#title').textContent=e.data.feature.title;document.querySelector('#project').textContent=e.data.project.name;document.documentElement.style.colorScheme=e.data.theme});parent.postMessage({type:'emachine:ready'},'*');</script></html>
  @fs.write_file(workspace + "/index.html", html, create_mode=CreateNew, permission=384)
  workspace
}

///|
pub async fn activate(config : @model.Config, project : @model.Project, id : String) -> @model.Feature {
  let lock = lock_project(config, project.id)
  defer lock.close()
  let base = @model.feature_data(config, project.id, id)
  let workspace = base + "/workspace"
  let diagnostic_path = base + "/diagnostic.json"
  let result : Result[@model.Feature, String] = try {
    let manifest = parse_manifest(@model.read_json(workspace + "/feature.json"))
    if manifest.id != id { fail("Manifest identity does not match its project workspace") }
    let state = state_path(config, project.id, id)
    @model.ensure_dir(state + "/artifacts")
    if !manifest.build.is_empty() {
      let log = @process.redirect_to_file(base + "/build.log", create_mode=CreateOrTruncate, permission=384)
      let code = @async.with_timeout(manifest.buildTimeoutMs, () => @process.run(
        manifest.build[0], manifest.build[1:], cwd=workspace[:], stdout=log, stderr=log,
        extra_env={"EMACHINE_PROJECT": project.path, "EMACHINE_FEATURE": workspace,
          "EMACHINE_STATE": state, "EMACHINE_ARTIFACTS": state + "/artifacts"}))
      if code != 0 { fail("Build exited with \{code}\n" + tail_text(base + "/build.log")) }
    }
    let output = if manifest.output == "." { @fs.realpath(workspace) } else { @model.safe_file(workspace, manifest.output) }
    let stage = base + "/releases/.pending-" + @native.random_id()
    copy_directory(output, stage)
    let revision = package_digest(stage, manifest)
    let entry = @model.safe_file(stage, manifest.entry)
    if @fs.kind(entry) != Regular { fail("Feature entry is not a regular file") }
    let release = base + "/releases/" + revision
    if @fs.exists(release) { @fs.rmdir(stage, recursive=true) }
    else { @fs.rename(stage, release) }
    let feature : @model.Feature = {
      id, title: manifest.title, revision,
      entry: "api/v1/features/\{project.id}/\{id}/\{revision}/" + manifest.entry,
      status: "ready", updatedAt: @native.now_ms(),
    }
    let receipt : Receipt = { feature, manifest, inputs: fingerprint(project, manifest) }
    @model.ensure_dir(base + "/receipts")
    @model.atomic_json(base + "/receipts/" + revision + ".json", receipt.to_json())
    let records = active(config, project.id)
    match records.search_by(record => record.feature.id == id) {
      Some(index) => records[index] = receipt
      None => records.push(receipt)
    }
    @model.atomic_json(@model.project_data(config, project.id) + "/current.json", records.to_json())
    if @fs.exists(diagnostic_path) { @fs.remove(diagnostic_path) }
    Ok(feature)
  } catch { error => Err(error.to_string()) }
  match result {
    Ok(feature) => feature
    Err(message) => {
      @model.ensure_dir(base)
      let diagnostic : @model.Diagnostic = {feature: id, message, updatedAt: @native.now_ms()}
      @model.atomic_json(diagnostic_path, diagnostic.to_json())
      fail(message)
    }
  }
}

///|
pub async fn remove(config : @model.Config, project : @model.Project, id : String) -> Unit {
  let lock = lock_project(config, project.id)
  defer lock.close()
  let base = @model.feature_data(config, project.id, id)
  let remaining = active(config, project.id).filter(record => record.feature.id != id)
  @model.atomic_json(@model.project_data(config, project.id) + "/current.json", remaining.to_json())
  if @fs.exists(base + "/diagnostic.json") { @fs.remove(base + "/diagnostic.json") }
}

///|
pub async fn mark_fresh(config : @model.Config, project : @model.Project, receipt : Receipt, inputs : String) -> Unit {
  let base = @model.feature_data(config, project.id, receipt.feature.id)
  @model.atomic_json(base + "/fresh.json", {"revision": receipt.feature.revision.to_json(), "inputs": inputs.to_json()})
}

///|
pub async fn inventory(config : @model.Config) -> @model.State {
  let projects = @model.discover(config)
  for project in projects {
    let records = active(config, project.id)
    for record in records {
      let feature = record.feature
      let base = @model.feature_data(config, project.id, feature.id)
      let fresh = if @fs.exists(base + "/fresh.json") { @model.read_json(base + "/fresh.json") } else { Json::null() }
      let previous = if @model.string_field(fresh, "revision") == feature.revision {
        @model.string_field(fresh, "inputs")
      } else { record.inputs }
      let status = if fingerprint(project, record.manifest) == previous { "ready" } else { "stale" }
      project.features.push({ ..feature, status })
    }
    let directory = @model.project_data(config, project.id) + "/features"
    if @fs.exists(directory) {
      for id in @fs.readdir(directory, sort=true) {
        if !@model.valid_id(id) { continue }
        let path = directory + "/" + id + "/diagnostic.json"
        if @fs.exists(path) { project.diagnostics.push(@json.from_json(@model.read_json(path))) }
      }
    }
  }
  { protocol: 1, machine: @model.machine(config), projects }
}

///|
async fn ensure_quiet(config : @model.Config, project : String, feature : String) -> Unit {
  let jobs = config.stateRoot + "/jobs"
  if @fs.exists(jobs) {
    for name in @fs.readdir(jobs) {
      if !name.has_suffix(".json") { continue }
      let job = @model.read_json(jobs + "/" + name)
      if @model.string_field(job, "project") == project && @model.string_field(job, "feature") == feature && @model.string_field(job, "status") == "running" {
        fail("Wait for the running feature job before checkpointing mutable state")
      }
    }
  }
}

///|
pub async fn checkpoint(config : @model.Config, project : @model.Project, id : String) -> String {
  let lock = lock_project(config, project.id)
  defer lock.close()
  ensure_quiet(config, project.id, id)
  let base = @model.feature_data(config, project.id, id)
  let checkpoint = @native.random_id()
  let destination = base + "/checkpoints/" + checkpoint
  copy_directory(base + "/workspace", destination + "/workspace")
  let state = state_path(config, project.id, id)
  if @fs.exists(state) { copy_directory(state, destination + "/state") }
  @model.atomic_json(destination + "/checkpoint.json", {
    "id": checkpoint.to_json(), "project": project.id.to_json(), "feature": id.to_json(),
    "createdAt": @native.now_ms().to_json(), "backend": "copy-reflink",
  })
  checkpoint
}

///|
pub async fn restore(config : @model.Config, project : @model.Project, id : String, checkpoint : String) -> Unit {
  if !@model.valid_id(checkpoint) { fail("Invalid checkpoint identity") }
  let lock = lock_project(config, project.id)
  defer lock.close()
  ensure_quiet(config, project.id, id)
  let base = @model.feature_data(config, project.id, id)
  let source = base + "/checkpoints/" + checkpoint
  let metadata = @model.read_json(source + "/checkpoint.json")
  if @model.string_field(metadata, "project") != project.id || @model.string_field(metadata, "feature") != id {
    fail("Checkpoint belongs to a different project or feature")
  }
  let backup = @native.random_id()
  let staged = base + "/restore-" + backup
  copy_directory(source + "/workspace", staged)
  let workspace = base + "/workspace"
  let previous = base + "/before-restore-" + backup
  @fs.rename(workspace, previous)
  @fs.rename(staged, workspace) catch {
    error => { @fs.rename(previous, workspace); raise error }
  }
  // State restoration is explicit and quiescent; retained source backups remain recoverable.
  if @fs.exists(source + "/state") {
    let state = state_path(config, project.id, id)
    let stage = state + "-restore-" + backup
    copy_directory(source + "/state", stage)
    if @fs.exists(state) { @fs.rename(state, state + "-before-restore-" + backup) }
    @fs.rename(stage, state)
  }
}
