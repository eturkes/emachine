///|
struct Job {
  id : String
  project : String
  feature : String
  action : String
  mut status : String
  startedAt : Int64
  mut finishedAt : Int64?
  mut exitCode : Int?
  mut message : String?
} derive(ToJson, @json.FromJson)

///|
fn job_busy(runtime : Runtime, project : String, feature : String) -> Bool {
  for _, job in runtime.jobs {
    if job.project == project && job.feature == feature && job.status == "running" { return true }
  }
  false
}

///|
fn running_jobs(runtime : Runtime) -> Int {
  let mut count = 0
  for _, job in runtime.jobs { if job.status == "running" { count = count + 1 } }
  count
}

///|
async fn recover_jobs(runtime : Runtime) -> Unit {
  let path = runtime.config.stateRoot + "/jobs"
  @model.ensure_dir(path)
  for name in @fs.readdir(path, sort=true) {
    if !name.has_suffix(".json") || name.has_suffix(".input.json") { continue }
    let job : Job = @json.from_json(@model.read_json(path + "/" + name))
    if job.status == "running" {
      job.status = "interrupted"
      job.finishedAt = Some(@native.now_ms())
      job.message = Some("Server supervision ended. The action was not retried; an abrupt crash may leave a child process running.")
      @model.atomic_json(path + "/" + name, @json.to_json(job))
    }
    runtime.jobs[job.id] = job
  }
}

///|
async fn start_job(runtime : Runtime, project_id : String, feature_id : String, action : String, input : Json) -> Job {
  let config = runtime.config
  let project = @model.resolve_project(config, project_id)
  let lock = @features.lock_project(config, project.id)
  defer lock.close()
  if job_busy(runtime, project.id, feature_id) { fail("A job is already running for this project feature") }
  if running_jobs(runtime) >= 4 { fail("Four jobs are already running on this machine") }
  let receipt = @features.get_active(config, project.id, feature_id)
  let argv = match receipt.manifest.actions.get(action) {
    Some(command) => command
    None => fail("This action is not declared by the active feature")
  }
  let id = @native.random_id()
  let jobs = config.stateRoot + "/jobs"
  let state = @features.state_path(config, project.id, feature_id)
  @model.ensure_dir(state + "/artifacts")
  let release = @model.feature_data(config, project.id, feature_id) + "/releases/" + receipt.feature.revision
  let inputs = @features.fingerprint(project, receipt.manifest)
  @model.atomic_json(jobs + "/" + id + ".input.json", input)
  let job : Job = { id, project: project.id, feature: feature_id, action, status: "running",
    startedAt: @native.now_ms(), finishedAt: None, exitCode: None, message: None }
  @model.atomic_json(jobs + "/" + id + ".json", @json.to_json(job))
  runtime.jobs[id] = job
  publish(runtime, {"type":"job", "job":@json.to_json(job)})
  runtime.group.spawn_bg(no_wait=true, allow_failure=true, () => {
    let outcome : Result[Int, String] = try {
      let log = @process.redirect_to_file(jobs + "/" + id + ".log", create_mode=CreateNew, permission=384)
      let stdin = @process.redirect_from_file(jobs + "/" + id + ".input.json")
      let code = @process.run(argv[0], argv[1:], cwd=release[:], stdin~, stdout=log, stderr=log,
        extra_env={"EMACHINE_PROJECT":project.path, "EMACHINE_FEATURE":release,
          "EMACHINE_STATE":state, "EMACHINE_ARTIFACTS":state + "/artifacts", "EMACHINE_JOB":id})
      Ok(code)
    } catch { error => Err(error.to_string()) }
    @async.protect_from_cancel(() => {
      job.finishedAt = Some(@native.now_ms())
      match outcome {
        Ok(code) => {
          job.exitCode = Some(code)
          job.status = if code == 0 { "succeeded" } else { "failed" }
          if code == 0 && action == "analyze" { @features.mark_fresh(config, project, receipt, inputs) }
        }
        Err(message) => {
          job.status = if @async.is_being_cancelled() { "interrupted" } else { "failed" }
          job.message = Some(message)
        }
      }
      @model.atomic_json(jobs + "/" + id + ".json", @json.to_json(job))
      publish(runtime, {"type":"job", "job":@json.to_json(job)})
    })
  })
  job
}

///|
async fn run_automatic(runtime : Runtime) -> Unit {
  if running_jobs(runtime) >= 4 { return }
  for project in runtime.state.projects {
    for feature in project.features {
      if feature.status != "stale" || job_busy(runtime, project.id, feature.id) { continue }
      let receipt = @features.get_active(runtime.config, project.id, feature.id)
      if receipt.manifest.refresh != "automatic" { continue }
      let fingerprint = @features.fingerprint(project, receipt.manifest)
      let marker = @model.feature_data(runtime.config, project.id, feature.id) + "/automatic-attempt.json"
      let previous = if @fs.exists(marker) { @model.read_json(marker) } else { Json::null() }
      if @model.string_field(previous, "revision") == feature.revision && @model.string_field(previous, "inputs") == fingerprint { continue }
      @model.atomic_json(marker, {"revision":feature.revision.to_json(), "inputs":fingerprint.to_json()})
      let _ = start_job(runtime, project.id, feature.id, "analyze", Json::null())
      if running_jobs(runtime) >= 4 { return }
    }
  }
}
