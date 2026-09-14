///|
fn help() -> Unit {
  println(
    #|emachine 0.1.0
    #|
    #|Usage:
    #|  emachine serve
    #|  emachine projects
    #|  emachine diagnostics PROJECT
    #|  emachine feature create PROJECT ID TITLE
    #|  emachine feature path PROJECT ID
    #|  emachine feature activate PROJECT ID
    #|  emachine feature remove PROJECT ID
    #|  emachine feature checkpoint PROJECT ID
    #|  emachine feature checkpoints PROJECT ID
    #|  emachine feature restore PROJECT ID CHECKPOINT
    #|
    #|PROJECT is a local name, canonical directory, or stable project ID.
    #|Features and checkpoints remain outside managed projects.
    #|Removing a tab preserves its source, releases, and state.
    #|Restoring a checkpoint does not activate it. Review, then activate.
    #|EMACHINE_CONFIG selects an alternate configuration file.
  )
}

///|
async fn main {
  let args = @env.args()
  if args.length() < 2 || args[1] == "--help" || args[1] == "help" { help(); return }
  if args[1] == "--version" { println("emachine 0.1.0"); return }
  let config = @model.load_config()
  if args[1] == "serve" { @server.serve(config); return }
  @model.initialize(config)
  match args[1:] {
    ["projects"] => println(@json.to_json(@features.inventory(config)).stringify(indent=2))
    ["diagnostics", name] => {
      let project = @model.resolve_project(config, name)
      let state = @features.inventory(config)
      println(@json.to_json(state.projects.filter(p => p.id == project.id)[0]).stringify(indent=2))
    }
    ["feature", "create", name, id, title] => {
      let project = @model.resolve_project(config, name)
      let workspace = @features.create(config, project, id, title)
      println(({"workspace":workspace.to_json(), "project":project.id.to_json(), "feature":id.to_json()} : Json).stringify())
    }
    ["feature", "path", name, id] => {
      let project = @model.resolve_project(config, name)
      println(@model.feature_data(config, project.id, id) + "/workspace")
    }
    ["feature", "activate", name, id] => {
      let project = @model.resolve_project(config, name)
      println(@json.to_json(@features.activate(config, project, id)).stringify(indent=2))
    }
    ["feature", "remove", name, id] => {
      let project = @model.resolve_project(config, name)
      @features.remove(config, project, id)
      println("Tab removed. Its external workspace and history are retained.")
    }
    ["feature", "checkpoint", name, id] => {
      let project = @model.resolve_project(config, name)
      println(@features.checkpoint(config, project, id))
    }
    ["feature", "checkpoints", name, id] => {
      let project = @model.resolve_project(config, name)
      let base = @model.feature_data(config, project.id, id) + "/checkpoints"
      let records : Array[Json] = []
      if @fs.exists(base) {
        for entry in @fs.readdir(base, sort=true) {
          if @model.valid_id(entry) { records.push(@model.read_json(base + "/" + entry + "/checkpoint.json")) }
        }
      }
      println(records.to_json().stringify(indent=2))
    }
    ["feature", "restore", name, id, checkpoint] => {
      let project = @model.resolve_project(config, name)
      @features.restore(config, project, id, checkpoint)
      println("Checkpoint restored. Review the workspace, then activate the feature.")
    }
    _ => { help(); fail("Unknown command or missing arguments") }
  }
}
