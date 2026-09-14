///|
test "SHA-256 uses standard vectors" {
  assert_eq(
    @native.sha256(b""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  )
  assert_eq(
    @native.sha256(b"abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  )
}

///|
test "tokens and constant-time comparison" {
  let a = @native.random_id()
  let b = @native.random_id()
  assert_eq(a.length(), 32)
  assert_true(a != b)
  assert_true(@native.secure_equal(a, a))
  assert_false(@native.secure_equal(a, b))
  assert_false(@native.secure_equal(a, a + "0"))
}

///|
test "native clock returns epoch milliseconds" {
  let now = @native.now_ms()
  assert_true(now > 1700000000000L)
  assert_true(now < 4102444800000L)
}
