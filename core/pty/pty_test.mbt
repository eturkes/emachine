///|
async fn read_to(terminal : @pty.Pty, marker : String) -> String {
  @async.with_timeout(12000, () => {
    let mut data = b""
    for ;; {
      let chunk = terminal.read()
      if chunk.is_empty() {
        fail("terminal closed before \{marker}")
      }
      data = data + chunk
      if chunk.find(b"\x1b[c") is Some(_) {
        terminal.write(b"\x1b[?1;2c")
      }
      if chunk.find(b"\x1b[6n") is Some(_) {
        terminal.write(b"\x1b[1;1R")
      }
      let text = @utf8.decode_lossy(data)
      if text.contains(marker) {
        return text
      }
      if data.length() > 1048576 {
        fail("terminal output exceeded test bound")
      }
    }
  })
}

///|
async test "real zmx cwd, Unicode, resize and persistent shell" {
  let root = @fs.tmpdir(prefix="em-pty-")
  let runtime = root + "/z"
  let cwd = root + "/project"
  @fs.mkdir(cwd)
  @fs.mkdir(runtime, permission=448)
  let session = "test-" + @native.random_id().substring(start=0, end=10)
  @async.with_task_group() <| group => {
    group.add_defer(() => {
      let _ = @process.collect_output("zmx", ["kill", session], extra_env={
        "ZMX_DIR": runtime,
      })
      @fs.rmdir(root, recursive=true)
    })
    let terminal = @pty.spawn(
      group,
      cwd,
      session,
      "/bin/bash",
      runtime,
      80,
      24,
      extra_env={
        "HOME": root,
        "HISTFILE": root + "/history",
        "PS1": "probe> ",
      },
    )
    defer terminal.close()
    terminal.write(
      @utf8.encode(
        "EMACHINE_PROBE=survives; printf '__CW''D__%s\\n' \"$PWD\"; printf '__UNI''CODE__π東京\\n'; printf '__FI''RST_DONE__\\n'\r",
      ),
    )
    let initial = read_to(terminal, "__FIRST_DONE__")
    assert_true(initial.contains("__CWD__" + cwd))
    assert_true(initial.contains("__UNICODE__π東京"))
    terminal.resize(111, 37)
    terminal.write(@utf8.encode("stty size; printf '__SI''ZE_DONE__\\n'\r"))
    let resized = read_to(terminal, "__SIZE_DONE__")
    assert_true(resized.contains("37 111"))
    terminal.close()
    let _ = @async.with_timeout(5000, () => terminal.wait())
    let reattached = @pty.spawn(
      group,
      cwd,
      session,
      "/bin/bash",
      runtime,
      111,
      37,
      extra_env={ "HOME": root, "HISTFILE": root + "/history" },
    )
    defer reattached.close()
    reattached.write(
      @utf8.encode(
        "printf '__VA''LUE__%s\\n' \"$EMACHINE_PROBE\"; printf '__SE''COND_DONE__\\n'\r",
      ),
    )
    let restored = read_to(reattached, "__SECOND_DONE__")
    assert_true(restored.contains("__VALUE__survives"))
    reattached.close()
    let _ = @async.with_timeout(5000, () => reattached.wait())
  }
}
