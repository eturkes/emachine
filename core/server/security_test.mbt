///|
test "direct and gateway access require the correct trust boundary" {
  let base = @model.test_config("/tmp/em-security")
  let config = {
    ..base,
    allowedUsers: ["owner@example.test"],
    allowedOrigins: [
      "http://127.0.0.1:4737", "https://work.example", "emachine://app",
    ],
    directUrl: "https://work.example/",
    gatewaySecret: "a-long-gateway-token-for-tests-only",
  }
  assert_true(@server.authorized(config, { "Host": "127.0.0.1:4737" }, false))
  assert_false(@server.authorized(config, { "Host": "evil.example" }, false))
  assert_false(
    @server.authorized(
      config,
      { "Host": "127.0.0.1:4737", "Origin": "https://evil.example" },
      true,
    ),
  )
  assert_false(@server.authorized(config, { "Host": "127.0.0.1:4737" }, true))
  assert_false(
    @server.authorized(
      config,
      { "Host": "127.0.0.1:4737", "Origin": "null" },
      true,
    ),
  )
  assert_false(
    @server.authorized(
      config,
      {
        "Host": "work.example",
        "X-Forwarded-For": "1.2.3.4",
        "Origin": "https://work.example",
      },
      true,
    ),
  )
  assert_true(
    @server.authorized(
      config,
      {
        "Host": "work.example",
        "Tailscale-User-Login": "owner@example.test",
        "Origin": "https://work.example",
      },
      true,
    ),
  )
  assert_false(
    @server.authorized(
      config,
      {
        "Host": "work.example",
        "Tailscale-User-Login": "other@example.test",
        "Origin": "https://work.example",
      },
      true,
    ),
  )
  assert_true(
    @server.authorized(
      config,
      {
        "Host": "work.example",
        "X-Emachine-Gateway": "a-long-gateway-token-for-tests-only",
        "Origin": "https://work.example",
      },
      true,
    ),
  )
  assert_false(
    @server.authorized(
      config,
      {
        "Host": "work.example",
        "X-Emachine-Gateway": "wrong",
        "Tailscale-User-Login": "owner@example.test",
        "Origin": "https://work.example",
      },
      true,
    ),
  )
}

///|
test "asset revisions and bounded query dimensions" {
  assert_true(
    @server.valid_revision(
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    ),
  )
  assert_false(@server.valid_revision("../workspace"))
  assert_false(@server.valid_revision("pending-test"))
  assert_eq(@server.dimension("cols=90&rows=25", "cols", 80), 90)
  assert_eq(@server.dimension("cols=999999999999", "cols", 80), 80)
  assert_eq(@server.dimension("cols=0", "cols", 80), 80)
  assert_eq(@server.dimension("cols=-1", "cols", 80), 80)
}
