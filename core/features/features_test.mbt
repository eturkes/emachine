///|
async test "project-local activation, failed build, checkpoint, removal" {
  let root = @fs.tmpdir(prefix="em-features-")
  @async.with_task_group() <| group => {
    group.add_defer(() => @fs.rmdir(root, recursive=true))
    @fs.mkdir(root + "/Projects/alpha", recursive=true)
    @fs.mkdir(root + "/Projects/beta", recursive=true)
    let config = @model.test_config(root)
    @model.initialize(config)
    let alpha = @model.resolve_project(config, "alpha")
    let beta = @model.resolve_project(config, "beta")
    let a = @features.create(config, alpha, "map", "Alpha map")
    let b = @features.create(config, beta, "map", "Beta map")
    assert_true(a != b)
    let first = @features.activate(config, alpha, "map")
    let other = @features.activate(config, beta, "map")
    @fs.write_file(
      a + "/feature.json",
      "{\"id\":\"map\",\"title\":\"broken\",\"entry\":\"index.html\",\"build\":[\"/usr/bin/false\"]}",
    )
    let failed = try {
      let _ = @features.activate(config, alpha, "map")
      false
    } catch {
      _ => true
    }
    assert_true(failed)
    let after_failure = @features.inventory(config)
    assert_eq(
      after_failure.projects.filter(p => p.id == alpha.id)[0].features[0].revision,
      first.revision,
    )
    assert_true(
      after_failure.projects.filter(p => p.id == alpha.id)[0].diagnostics.length() >
      0,
    )
    @fs.write_file(
      a + "/feature.json",
      "{\"id\":\"map\",\"title\":\"Alpha map\",\"entry\":\"index.html\"}",
    )
    @fs.write_file(
      a + "/index.html",
      "<!doctype html><title>Alpha version 2</title><p>Changed only here</p>",
    )
    let second = @features.activate(config, alpha, "map")
    assert_true(second.revision != first.revision)
    let after_update = @features.inventory(config)
    assert_eq(
      after_update.projects.filter(p => p.id == beta.id)[0].features[0].revision,
      other.revision,
    )
    let checkpoint = @features.checkpoint(config, alpha, "map")
    @fs.write_file(a + "/index.html", "unwanted edit")
    @features.restore(config, alpha, "map", checkpoint)
    assert_true(
      @fs.read_file(a + "/index.html").text().contains("Alpha version 2"),
    )
    @features.remove(config, alpha, "map")
    let after_removal = @features.inventory(config)
    assert_eq(
      after_removal.projects.filter(p => p.id == alpha.id)[0].features.length(),
      0,
    )
    assert_eq(
      after_removal.projects.filter(p => p.id == beta.id)[0].features.length(),
      1,
    )
    assert_eq(@fs.readdir(alpha.path).length(), 0)
    assert_eq(@fs.readdir(beta.path).length(), 0)
  }
}

///|
test "manifest paths and commands are validated" {
  let good = @features.parse_manifest({
    "id": "tree",
    "title": "Tree",
    "entry": "index.html",
  })
  assert_eq(good.id, "tree")
  for entry in ["../index.html", "/etc/passwd", "a/../b"] {
    let rejected = try {
      let _ = @features.parse_manifest({
        "id": "tree",
        "title": "Tree",
        "entry": entry.to_json(),
      })
      false
    } catch {
      _ => true
    }
    assert_true(rejected)
  }
}

///|
async test "render diagnostics are visible and restored absent state is empty" {
  let root = @fs.tmpdir(prefix="em-recovery-")
  @async.with_task_group() <| group => {
    group.add_defer(() => @fs.rmdir(root, recursive=true))
    @fs.mkdir(root + "/Projects/alpha", recursive=true)
    let config = @model.test_config(root)
    @model.initialize(config)
    let project = @model.resolve_project(config, "alpha")
    let _ = @features.create(config, project, "view", "View")
    let before = @features.checkpoint(config, project, "view")
    let feature = @features.activate(config, project, "view")
    let state = @features.state_path(config, project.id, "view")
    @fs.write_file(state + "/future.txt", "not present at checkpoint")
    let base = @model.feature_data(config, project.id, "view")
    @model.atomic_json(base + "/render-diagnostic.json", {
      "feature": "view",
      "revision": feature.revision.to_json(),
      "message": "A real rendering failure",
      "updatedAt": 1,
    })
    let inventory = @features.inventory(config)
    assert_true(
      inventory.projects[0].diagnostics.any(d => {
        d.message == "A real rendering failure"
      }),
    )
    @features.restore(config, project, "view", before)
    assert_false(@fs.exists(state + "/future.txt"))
    assert_eq(@fs.readdir(project.path).length(), 0)
  }
}

///|
async test "invalid packages leave no candidate release directories" {
  let root = @fs.tmpdir(prefix="em-invalid-package-")
  @async.with_task_group() <| group => {
    group.add_defer(() => @fs.rmdir(root, recursive=true))
    @fs.mkdir(root + "/Projects/alpha", recursive=true)
    let config = @model.test_config(root)
    @model.initialize(config)
    let project = @model.resolve_project(config, "alpha")
    let workspace = @features.create(config, project, "view", "View")
    @fs.write_file(
      workspace + "/feature.json",
      "{\"id\":\"view\",\"title\":\"View\",\"entry\":\"missing.html\"}",
    )
    let failed = try {
      let _ = @features.activate(config, project, "view")
      false
    } catch {
      _ => true
    }
    assert_true(failed)
    let releases = @model.feature_data(config, project.id, "view") + "/releases"
    assert_false(
      @fs.readdir(releases, include_hidden=true).any(name => {
        name.has_prefix(".pending-")
      }),
    )
  }
}

///|
test "the built-in terminal identity is reserved" {
  let rejected = try {
    let _ = @features.parse_manifest({
      "id": "terminal",
      "title": "Conflicting view",
    })
    false
  } catch {
    _ => true
  }
  assert_true(rejected)
}

///|
async test "analysis freshness belongs to a specific feature revision" {
  let root = @fs.tmpdir(prefix="em-freshness-")
  @async.with_task_group() <| group => {
    group.add_defer(() => @fs.rmdir(root, recursive=true))
    @fs.mkdir(root + "/Projects/alpha", recursive=true)
    let config = @model.test_config(root)
    @model.initialize(config)
    let project = @model.resolve_project(config, "alpha")
    let workspace = @features.create(config, project, "report", "Report")
    @model.atomic_json(workspace + "/feature.json", {
      "id": "report",
      "title": "Report",
      "actions": { "analyze": ["/bin/true"] },
    })
    let _ = @features.activate(config, project, "report")
    assert_eq(
      @features.inventory(config).projects[0].features[0].status,
      "stale",
    )
    let receipt = @features.get_active(config, project.id, "report")
    @features.mark_fresh(
      config,
      project,
      receipt,
      @features.fingerprint(project, receipt.manifest),
    )
    assert_eq(
      @features.inventory(config).projects[0].features[0].status,
      "ready",
    )
    @fs.write_file(
      workspace + "/index.html",
      "<title>Changed analysis view</title>",
    )
    let _ = @features.activate(config, project, "report")
    assert_eq(
      @features.inventory(config).projects[0].features[0].status,
      "stale",
    )
  }
}
