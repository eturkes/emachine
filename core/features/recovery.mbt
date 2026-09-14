///|
async fn storage_backend(path : String) -> String {
  let marker = path + ".storage.json"
  if @fs.exists(marker) {
    @model.string_field(
      @model.read_json(marker),
      "backend",
      fallback="copy-reflink",
    )
  } else {
    "copy-reflink"
  }
}

///|
async fn record_storage(path : String, backend : String) -> Unit {
  @model.atomic_json(path + ".storage.json", { "backend": backend.to_json() })
}

///|
async fn ensure_boundary(config : @model.Config, path : String) -> Unit {
  if @fs.exists(path) {
    @model.ensure_dir(path)
    return
  }
  @model.ensure_dir(@model.parent(path))
  let mut backend = "copy-reflink"
  // Only newly created emachine-owned boundaries qualify. Never snapshot an ancestor.
  let native = if config.snapshotBackend == "auto" {
    try {
      let (code, output, _) = @process.collect_output("stat", [
        "-f",
        "-c",
        "%T",
        "--",
        @model.parent(path),
      ])
      if code == 0 && output.text().trim() == "bcachefs" {
        let (created, _, _) = @process.collect_output("bcachefs", [
          "subvolume", "create", path,
        ])
        created == 0
      } else {
        false
      }
    } catch {
      _ => false
    }
  } else {
    false
  }
  if native {
    backend = "bcachefs"
  }
  @model.ensure_dir(path)
  @fs.chmod(path, 448)
  record_storage(path, backend)
}

///|
async fn clone_boundary(
  source : String,
  destination : String,
  backend : String,
  read_only : Bool,
) -> String {
  @model.ensure_dir(@model.parent(destination))
  if backend == "bcachefs" {
    let cloned = try {
      let flag = if read_only { "--read-only" } else { "--rw" }
      let (code, _, _) = @process.collect_output("bcachefs", [
        "subvolume", "snapshot", flag, source, destination,
      ])
      code == 0
    } catch {
      _ => false
    }
    if cloned {
      return "bcachefs"
    }
  }
  copy_directory(source, destination)
  "copy-reflink"
}

///|
async fn checkpoint_locked(
  config : @model.Config,
  project : @model.Project,
  id : String,
  include_state : Bool,
) -> String {
  let base = @model.feature_data(config, project.id, id)
  let checkpoint = @native.random_id()
  let destination = base + "/checkpoints/" + checkpoint
  let workspace = base + "/workspace"
  let workspace_backend = clone_boundary(
    workspace,
    destination + "/workspace",
    storage_backend(workspace),
    true,
  )
  let state = state_path(config, project.id, id)
  let state_backend = if include_state && @fs.exists(state) {
    clone_boundary(state, destination + "/state", storage_backend(state), true)
  } else if include_state {
    "absent"
  } else {
    "not-captured"
  }
  @model.atomic_json(destination + "/checkpoint.json", {
    "id": checkpoint.to_json(),
    "project": project.id.to_json(),
    "feature": id.to_json(),
    "createdAt": @native.now_ms().to_json(),
    "backend": workspace_backend.to_json(),
    "workspaceBackend": workspace_backend.to_json(),
    "stateBackend": state_backend.to_json(),
  })
  checkpoint
}

///|
pub async fn begin(
  config : @model.Config,
  project : @model.Project,
  id : String,
) -> String {
  let lock = lock_project(config, project.id)
  defer lock.close()
  checkpoint_locked(config, project, id, false)
}
