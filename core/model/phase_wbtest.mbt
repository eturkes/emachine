///|
test "phase tokens follow the explicit declaration" {
  for name in ["PROTOTYPE", "ITERATE", "IMPLEMENT", "MAINTAIN"] {
    for suffix in ["", ". Feedback next.", " (M5 open).", ", milestone M13."] {
      assert_eq(phase_from_spec("# Spec\n## Phase\n\n" + name + suffix), name)
    }
  }
  assert_eq(
    phase_from_spec(
      "## Phase\nITERATE. IMPLEMENT is suspended.\nMAINTAIN later.",
    ),
    "ITERATE",
  )
}

///|
test "phase accepts field emphasis case and line endings" {
  for
    line in [
      "Phase: IMPLEMENT", "**Phase:** **implement**", "Phase: `IMPLEMENT`", "Phase: __IMPLEMENT__",
      "## Phase\nPhase: IMPLEMENT", "## Phase\n**IMPLEMENT**",
    ] {
    assert_eq(phase_from_spec("\uFEFF# Spec\r\n" + line + "\r\n"), "IMPLEMENT")
  }
}

///|
test "phase ignores mentions examples quotes and comments" {
  let examples = "# Spec\nIMPLEMENT is a goal.\n```markdown\n## Phase\nMAINTAIN\n```\n~~~\nPhase: PROTOTYPE\n~~~\n> Phase: MAINTAIN\n<!--\nPhase: IMPLEMENT\n-->\n    Phase: MAINTAIN\n"
  assert_eq(phase_from_spec(examples), "UNKNOWN")
  assert_eq(
    phase_from_spec(examples + "\n## Phase\nITERATE. IMPLEMENT suspended.\n"),
    "ITERATE",
  )
  assert_eq(
    phase_from_spec("<!-- example -->\nPhase: IMPLEMENT <!-- note -->"),
    "IMPLEMENT",
  )
}

///|
test "phase missing unsupported and duplicated never guess" {
  for
    text in [
      "", "# Spec\n## Intent\nMake a thing.", "## Phase\n\n## Decisions\nIMPLEMENT",
      "## Phase\nRESEARCH before IMPLEMENT", "Phase: IMPLEMENTATION", "Phase: ITERATE\nPhase: ITERATE",
      "## Phase\nITERATE\n## Phase\nIMPLEMENT", "Phase: MAINTAIN\n## Phase\nIMPLEMENT",
      "## Phase\nITERATE\nPhase: MAINTAIN", "## Phase\nPhase: IMPLEMENT\nPhase: ITERATE",
      "## Phase\nITERATE\n### Phase\nIMPLEMENT", "## Phase\nWaiting.\nIMPLEMENT",
    ] {
    assert_eq(phase_from_spec(text), "UNKNOWN")
  }
}

///|
test "indented code fence markers do not expose example phases" {
  for closing in ["    ```", "\t```", "  \t```"] {
    assert_eq(
      phase_from_spec("```markdown\n" + closing + "\nPhase: MAINTAIN\n"),
      "UNKNOWN",
    )
  }
  assert_eq(phase_from_spec("```markdown\n   ```\nPhase: ITERATE\n"), "ITERATE")
}

///|
test "project phase JSON round trips null and known values" {
  for phase in [None, Some("ITERATE")] {
    let project : Project = {
      id: "test",
      name: "test",
      path: "/test",
      phase,
      claudeStatus: None,
      features: [],
      diagnostics: [],
    }
    let decoded : Project = @json.from_json(project.to_json())
    assert_eq(decoded.phase, phase)
  }
  let old : Project = @json.from_json({
    "id": "test",
    "name": "test",
    "path": "/test",
    "features": [],
    "diagnostics": [],
  })
  assert_eq(old.phase, None)
}
