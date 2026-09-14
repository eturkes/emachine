# Acceptance checks

## Reproducible gates

| Command | Coverage |
| --- | --- |
| `pnpm verify` | Type checking, native checking, 15 native tests, production builds, 7 network test results, and 6 browser tests |
| `pnpm appimage` | Production browser bundle and x86-64 Linux AppImage |
| `pnpm test:desktop` | Real AppImage, renderer isolation, a real fixture machine, and zmx attachment |
| `node tests/desktop.mjs --configured` | The desktop gate plus the seeded Tailscale machine and its existing project terminal |
| `node scripts/check-installation.mjs` | Enabled and active service, valid systemd unit, disjoint storage, HTTPS, exact desktop CORS, and credential-free client files |
| `git diff --check` | Patch whitespace integrity |

The native and network gates use real filesystem operations and zmx processes. Browser tests use ChromiumFish and real native fixture servers. The configured desktop gate sends no shell commands to the existing project.

The six browser tests cover route-prefix boundaries, concurrent machines, keyboard input, directory discovery, isolated feature replacement, phone layout, offline caching, fallback routing, deduplication, reconnect behavior, and recovered jobs.

Source gates and packaged-client checks passed. The installation check passed. An independent HTTPS health request from the FreeBSD host also returned `200 OK` with certificate and hostname verification enabled.

MoonBit emits warning-only diagnostics for declaration visibility and deprecated JSON depth parameters. These are not suppressed. No native test failures or type-check errors remain.

## Regression evidence

The fixes were exercised against failing checks before correction:

| Regression | Observed failure | Correction |
| --- | --- | --- |
| Terminal identity collision | The reserved-ID native test accepted `terminal` | Reject the built-in terminal ID in feature manifests |
| Analysis freshness | A newly activated analysis feature reported `ready` before running | Require a successful receipt for the active revision |
| Offline shell | The phone test could not load cached JavaScript and CSS | Ignore CORS `Vary` differences only for allowlisted static shell cache entries |
| Job recovery | The reopened browser did not show the completed server job | Fetch persisted jobs after connection and preserve newer completion events |
| Route boundaries | The URL test rejected a legitimate filename containing two dots | Validate decoded path segments and the resolved machine route boundary |
| Service installation | systemd rejected the quoted working-directory field | Remove the unnecessary field and validate units before installation |

Red logs and source hashes are retained under `.work/`. These failures came from a recovered, uncommitted worktree based on `fbcab1e`, not from that commit alone. The source hashes are recorded in the implementation commit body.

## Unverified or blocked

The FreeBSD public gateway is not deployed. Its jail needs a narrow NAT exception and an authenticated Caddy route. The connector blocked those changes.

Physical iPhone and Android behavior has not been exercised. The phone test uses a 390-by-844 Chromium viewport. Browser storage eviction remains outside the application's control.

The bcachefs adapter is implemented, but live native snapshots have not been exercised on this machine. Copy-based checkpoints and recovery are covered by native and network tests.

Camera, microphone, notifications, legacy plugin migration, and arbitrary process-memory restoration are not implemented acceptance targets.
