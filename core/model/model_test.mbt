///|
test "feature identifiers and relative paths" {
  for id in ["a", "source-map", "pipeline2"] { assert_true(@model.valid_id(id)) }
  for id in ["", "../x", "A", "a/b", "a b", "日本", "-x"] { assert_false(@model.valid_id(id)) }
  assert_true(@model.safe_relative("assets/main.js"))
  for path in ["/etc/passwd", "../x", "a/../x", "a//b", "a\\b", "a\x00b"] {
    assert_false(@model.safe_relative(path))
  }
}

///|
test "URL decoding rejects hidden traversal after decoding" {
  assert_eq(@model.url_decode("a%20b"), "a b")
  assert_eq(@model.url_decode("%E6%97%A5"), "日")
  assert_false(@model.safe_relative(@model.url_decode("%2e%2e%2fsecret")))
  assert_false(@model.safe_relative(@model.url_decode("assets%2f..%2fx")))
  assert_false(@model.valid_id(@model.url_decode("project%2fother")))
}

///|
async test "project identity survives rename and does not write into projects" {
  let root = @fs.tmpdir(prefix="em-model-")
  let projects = root + "/Projects"
  @fs.mkdir(projects)
  @fs.mkdir(projects + "/alpha")
  @fs.mkdir(projects + "/beta")
  let config = @model.test_config(root)
  @model.initialize(config)
  let first = @model.discover(config)
  assert_eq(first.length(), 2)
  let alpha = first.filter(p => p.name == "alpha")[0]
  @fs.rename(projects + "/alpha", projects + "/renamed")
  let second = @model.discover(config)
  assert_eq(second.filter(p => p.name == "renamed")[0].id, alpha.id)
  assert_eq(@fs.readdir(projects + "/renamed").length(), 0)
  assert_eq(@fs.readdir(projects + "/beta").length(), 0)
  @fs.rmdir(root, recursive=true)
}
