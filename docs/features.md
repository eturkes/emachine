# Project feature authoring

Create a feature with the local CLI. It returns a directory outside the managed project. The directory contains `feature.json` and an initial HTML page.

```json
{
  "id": "pipeline",
  "title": "Pipeline",
  "entry": "index.html",
  "output": ".",
  "build": [],
  "watch": ["src", "README.md"],
  "refresh": "manual",
  "actions": {
    "analyze": ["python3", "analyze.py"]
  }
}
```

The `build` field is an argument array. An empty array publishes existing files. For a bundled frontend, set `output` to its build directory. Include every required worker script in that output.

IDs use lowercase letters, digits, and hyphens. The ID `terminal` is reserved. Entry and output paths must stay inside the workspace. Published packages reject symlinks, `.git`, and `node_modules`.

The browser loads the feature in its own iframe. It is not sandboxed as untrusted code. The parent supplies machine, project, feature, route, and theme context through a checked message exchange.

## Optional browser SDK

Copy `web/public/sdk.js` and `sdk.css` into the feature workspace when creating it. This gives the feature its own editable SDK version.

```html
<link rel="stylesheet" href="sdk.css">
<button id="analyze">Analyze</button>
<pre id="status"></pre>
<script type="module">
  import { emachine } from './sdk.js';
  const context = await emachine.ready;
  document.title = `${context.project.name}: Pipeline`;
  const status = document.querySelector('#status');
  document.querySelector('#analyze').onclick = async () => {
    try {
      const job = await emachine.run('analyze', { detail: 'modules' });
      status.textContent = `Running ${job.id}`;
    } catch (error) {
      status.textContent = String(error);
      await emachine.report(error);
    }
  };
  emachine.onJob(job => { status.textContent = job.status; });
</script>
```

The SDK reports rendering errors to the server through the parent. Codexify can retrieve them with `emachine diagnostics PROJECT`.

Use `emachine.job(id)` to recover a known job after reconnecting. Use `await emachine.artifact('result.json')` to obtain an authenticated artifact URL. Store useful view selections in project-specific feature state rather than relying on the iframe's lifetime.

## Theme

Use neutral grayscale surfaces, text, borders, controls, focus indicators, and selections in both themes. Match the parent theme. The SDK's `--accent` token provides neutral emphasis, not a brand color.

Reserve color for functional states or data distinctions. Use separate semantic tokens for these roles. Pair colored status indicators with text or symbols. Keep decorative backgrounds and ordinary navigation neutral.

Copy theme styles into each feature workspace. Feature releases must keep their own pinned styles. Copy `tests/theme-contract.mjs` into the workspace to check neutral surfaces and text contrast in the feature's browser gate.

## Server actions

An action receives JSON on standard input. Its working directory is the immutable active release, not the managed project. The server supplies these environment variables:

| Variable | Value |
| --- | --- |
| `EMACHINE_PROJECT` | Canonical managed project directory |
| `EMACHINE_FEATURE` | Active release directory |
| `EMACHINE_STATE` | External mutable state directory |
| `EMACHINE_ARTIFACTS` | External artifact directory |
| `EMACHINE_JOB` | Job identity |

Read project input through `EMACHINE_PROJECT`. Write generated results under `EMACHINE_ARTIFACTS`. Write internal state under `EMACHINE_STATE`. Standard output and standard error become the bounded-view job log.

Publish validated results with an atomic rename. A failed worker must leave the previous successful result intact.

Jobs belong to the server. Closing a tab or suspending a phone does not cancel them. A normal server shutdown cancels supervised actions. Interrupted work is not automatically retried. After an abrupt crash, inspect potentially surviving child processes before restoring mutable state.

One job may run per feature, with at most four jobs per machine. Declared actions are trusted commands, not shell expressions supplied by the browser.

## Freshness and publication

Watch paths are project-relative files or directories. Fingerprints include file contents, including uncommitted changes. Broad scans have file-count and size budgets; select narrow inputs for large projects.

A declared `analyze` action starts stale until it succeeds for the active feature revision. Input or feature-revision changes invalidate freshness while retaining prior artifacts.

`refresh: "manual"` never starts analysis from an input change. `refresh: "automatic"` requires an `analyze` action and permits one attempt for each revision and input fingerprint. Use this only for cheap deterministic work.

Feature activation validates and builds before replacing the project's active metadata. Overlapping activations serialize per project. A newer activation request supersedes an older unfinished request.

Use `feature begin` before editing. Use `feature checkpoint` before a deliberate mutable-state change. Restoring source or data cannot undo external side effects.
