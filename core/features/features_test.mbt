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
    @fs.write_file(a + "/feature.json", "{\"id\":\"map\",\"title\":\"broken\",\"entry\":\"index.html\",\"build\":[\"/usr/bin/false\"]}")
    let failed = try { let _ = @features.activate(config, alpha, "map"); false } catch { _ => true }
    assert_true(failed)
    let after_failure = @features.inventory(config)
    assert_eq(after_failure.projects.filter(p => p.id == alpha.id)[0].features[0].revision, first.revision)
    assert_true(after_failure.projects.filter(p => p.id == alpha.id)[0].diagnostics.length() > 0)
    @fs.write_file(a + "/feature.json", "{\"id\":\"map\",\"title\":\"Alpha map\",\"entry\":\"index.html\"}")
    @fs.write_file(a + "/index.html", "<!doctype html><title>Alpha version 2</title><p>Changed only here</p>")
    let second = @features.activate(config, alpha, "map")
    assert_true(second.revision != first.revision)
    let after_update = @features.inventory(config)
    assert_eq(after_update.projects.filter(p => p.id == beta.id)[0].features[0].revision, other.revision)
    let checkpoint = @features.checkpoint(config, alpha, "map")
    @fs.write_file(a + "/index.html", "unwanted edit")
    @features.restore(config, alpha, "map", checkpoint)
    assert_true(@fs.read_file(a + "/index.html").text().contains("Alpha version 2"))
    @features.remove(config, alpha, "map")
    let after_removal = @features.inventory(config)
    assert_eq(after_removal.projects.filter(p => p.id == alpha.id)[0].features.length(), 0)
    assert_eq(after_removal.projects.filter(p => p.id == beta.id)[0].features.length(), 1)
    assert_eq(@fs.readdir(alpha.path).length(), 0)
    assert_eq(@fs.readdir(beta.path).length(), 0)
  }
}

///|
test "manifest paths and commands are validated" {
  let good = @features.parse_manifest({"id":"tree", "title":"Tree", "entry":"index.html"})
  assert_eq(good.id, "tree")
  for entry in ["../index.html", "/etc/passwd", "a/../b"] {
    let rejected = try {
      let _ = @features.parse_manifest({"id":"tree", "title":"Tree", "entry":entry.to_json()})
      false
    } catch { _ => true }
    assert_true(rejected)
  }
}
