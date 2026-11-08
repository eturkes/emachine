# Acceptance checks

## Reproducible gates

| Command | Coverage |
| --- | --- |
| `pnpm verify` | Type and native checking, native tests, release metadata tests, interface and IPC tests, production builds, network tests, and browser tests |
| `pnpm test:iphone` | iPhone 13 mini WebKit touch flows, terminal layout checks, named screenshots and replayable traces |
| `pnpm test:gateway` | Real Caddy authentication, hostile headers and origins, HTTP and WebSocket proxying, native fixture terminal, and phone-sized PWA without private-route requests |
| `pnpm appimage` | Production browser bundle and x86-64 Linux AppImage |
| `pnpm test:desktop` | Real AppImage, renderer isolation, absent app-updater bridge and dependency, a real fixture machine, and zmx attachment |
| `node tests/desktop.mjs --interface` | Existing AppImage with the built interface, sidebar collapse and terminal refitting, system clipboard buttons, shortcuts, context menu, terminal focus, and feature-frame permission denial |
| `pnpm test:interface` | Manifest and source boundaries, selective caching, offline startup, readiness rollback, concurrent pointer writes and cleanup, unavailable-cache recovery, and isolated IPC |
| `pnpm test:desktop-interface` | Real AppImage, native source approval, UI-only transfer, unchanged process and binary, retained selection and live terminal, feature-frame isolation, integrity and bridge rejection, offline startup, and native recovery |
| `pnpm test:window-state` | Saved dimensions and maximized state, startup rounding, special-state bounds, malformed preferences, display constraints, atomic writes, close flushing, and profile isolation |
| `pnpm test:desktop-window-state` | Real AppImage relaunches after resizing, maximizing, restoring, minimized/fullscreen closure, and repeated fractional-DPI launches without growth |
| `pnpm test:tailscale-network` | Local peer mapping, address validation, explicit routing switches, and fallback when discovery fails |
| `pnpm test:desktop-tailscale-network` | AppImage default proxy, saved direct mode, TLS hostname and WebSockets, and opt-out. Uses a private Linux network namespace with a fixture peer and a proxy. |
| `node tests/desktop.mjs --configured` | The desktop gate plus the seeded Tailscale machine and its existing project terminal |
| `node scripts/check-installation.mjs` | Enabled and active service, valid systemd unit, disjoint storage, HTTPS, exact desktop CORS, and credential-free client files |
| `git diff --check` | Patch whitespace integrity |

The native and network gates use real filesystem operations and zmx processes. Browser tests use ChromiumFish and real native fixture servers. The configured desktop gate sends no shell commands to the existing project.

Browser tests cover route-prefix boundaries, concurrent machines, keyboard input, directory discovery, isolated feature replacement, phone layout, offline caching, fallback routing, deduplication, and reconnect behavior.
They also cover recovered jobs, neutral light colors, explicit theme persistence, and absent app-update controls with a legacy desktop bridge.
Project checks cover root `CLAUDE.md` eligibility, uncommitted phase changes, inventory events, unknown states, and `.snapshots` + `.pnpm-store` exclusion, including registered identities. Other dot-prefixed directories remain eligible.
Sidebar checks cover cached snapshot and pnpm-store exclusion, terminal continuity, and readable one-word phase labels in both themes.
Header checks exercise light and dark colors at 320, 390, 720, and 1360 pixels without clipped controls.
Layout checks cover a persistent desktop sidebar toggle, terminal and feature-view continuity, and an independent phone drawer; legacy collapse preferences remain ignored. They reject decorative initials, redundant strips, and Jobs or Workspaces buttons.
Shortcut checks compare outgoing terminal bytes and native hardware modifiers, verify clipboard selection and failure handling, and retain observer control without a footer. Layout checks keep Keyboard/Esc/Tab pinned, group Shift+Left with the other key combinations, separate text and prompt tools from emitted keys, and fit phone, tablet, and keyboard-reduced viewports. Attaching and observer status stay outside the key scroller, leave terminal output unobscured, and preserve toolbar geometry.
Clipboard checks cover Ctrl+Shift+C/V, unchanged Ctrl+C, single bracketed paste, selection actions, keyboard navigation, menu dismissal, and mouse-reporting applications.
The browser clipboard fixture specifies Linux explicitly because ChromiumFish advertises Windows by default.
The desktop clipboard gate saves and restores all system clipboard formats, including when a check fails.

The interface gate serves temporary web files with the desktop CORS origin. Source approval still passes through the production IPC handler.
Its native confirmation response is controlled only by the test's main-process connection.
Changed index files exercise real staging and reloads. Unchanged fonts and scripts must not be fetched from the server.
The interface gate modifies no installed client, personal profile, or user project.

Source gates and packaged-client checks passed. The installation check passed. An independent HTTPS health request from the FreeBSD host also returned `200 OK` with certificate and hostname verification enabled.

MoonBit emits warning-only diagnostics for declaration visibility and deprecated JSON depth parameters. These are not suppressed. No native test failures or type-check errors remain.

## Review an iPhone 13 mini UI change

On a fresh CachyOS checkout, install the locked dependencies and run `pnpm build:server` with the MoonBit version listed in the README. Rebuild the server after native changes. For each UI revision, run these commands from the checkout root.

```sh
pnpm test:iphone
pnpm exec playwright show-report playwright-report/iphone-13-mini
```

The first command builds the current web source under `.work/iphone-13-mini-web` and runs it against a temporary loopback machine with two projects and real zmx shells. The second opens the report. Select either test to inspect its screenshots or replay the taps in its trace. For a before/after review, copy the report directory before running the next revision. The original named PNGs and traces are under `test-results/iphone-13-mini/`.

| View | What to inspect |
| --- | --- |
| Portrait, 375 × 629 CSS px | Light and dark terminal text, line wrapping, fixed keys, and the project drawer while switching shells. |
| Portrait with 400 CSS px visible | A focused Text draft, the Send button, and the space left for output. The test models a keyboard by shrinking the visual viewport and checks that the draft reaches the fixture shell after Send and Enter. |
| Landscape, 712 × 327 CSS px | The project rail with the terminal beside it, then the wider terminal grid after hiding the rail. |

The two browser sizes come from the pinned Playwright iPhone 13 Mini profiles, which emulate touch and render at 3×. The 400 px case is a chosen stress size. To check the physical iPhone, repeat the flows in Safari and from the Home Screen icon. Open and dismiss the system keyboard, rotate with the terminal open, and check controls near the notch and home indicator. Use **Copy** on sample output to check native selection handles. Connection steps are in [iPhone access](phone-access.md).

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

The host-local phone gateway has a separate [setup and verification workflow](phone-access.md).
Local authentication and proxy tests do not prove public Funnel reachability. Verify that route after Tailscale approval.

Physical iPhone and Android behavior has not been exercised. Browser storage eviction remains outside the application's control.

The bcachefs adapter is implemented, but live native snapshots have not been exercised on this machine. Copy-based checkpoints and recovery are covered by native and network tests.

Camera, microphone, notifications, legacy plugin migration, and arbitrary process-memory restoration are not implemented acceptance targets.
