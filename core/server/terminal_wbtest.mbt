///|
test "General accepts exact custom zmx names" {
  for
    session in [
      "general", "general2", "general0", "general1", "general01", "General", "work notes",
      "review \u6771\u4eac", "scratch %2F+?#", ".hidden", "a;b$()",
    ] {
    assert_true(valid_general_session(session))
  }
}

///|
test "General session limits count UTF-8 bytes" {
  let ascii = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  let unicode = "\u6771\u6771\u6771\u6771\u6771\u6771\u6771\u6771\u6771\u6771\u6771\u6771\u6771\u6771\u6771\u6771"
  assert_true(valid_general_session(ascii))
  assert_false(valid_general_session(ascii + "a"))
  assert_true(valid_general_session(unicode))
  assert_false(valid_general_session(unicode + "a"))
}

///|
test "General rejects path components flags controls and edge whitespace" {
  for
    session in [
      "", ".", "..", "-h", "--help", "--labels=a=b", "path/session", "back\\slash",
      "null\u0000name", "tab\tname", "line\nname", "line\rname", "delete\u007fname",
      " name", "name ", "\u00a0name", "name\u1680", "\u2000name", "name\u200a", "\u2028name",
      "name\u2029", "\u202fname", "name\u205f", "\u3000name", "name\uFEFF",
    ] {
    assert_false(valid_general_session(session))
  }
}
