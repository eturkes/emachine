# emachine

## Scope

- Personal Linux machine daemon = MoonBit native. Browser shell = TypeScript/DOM/xterm. Desktop = isolated Electron AppImage. No server federation.
- Source checkout outside managed projects. Discovery = immediate project-root directories. Emachine-owned files always outside managed projects.
- Initial project = lazy zmx terminal. Feature identity `(machine, project, feature)`; source/state/releases independently owned. `terminal` reserved.
- Maintain terminal/process lifetime independently of browser component lifetime. Disconnected input is dropped; reconnect never replays uncertain input.
- Direct Tailscale owner access; exact Origin checks. Public gateway needs independent browser authentication + private upstream credential. Secrets stay out of code, bundles, URLs, logs.
- Feature code trusted, normal account permissions. Arbitrary interfaces/actions allowed; subprocess boundaries provide fault isolation, not a security sandbox.

## Feature iteration

- `emachine feature create PROJECT ID TITLE` → external workspace. `feature begin` → source checkpoint. Edit there; `feature activate` → checked release + project-local activation.
- Failed candidate retains source/diagnostics; active release unchanged. Update only affected frame. Independent terminal/frame instances stay mounted.
- Model-backed analysis = manual by default. Preserve artifacts and mark stale. Explicit cheap automatic analyze actions only; one attempt per revision/input fingerprint.
- Checkpoint = emachine-owned boundaries only. Backend recorded; native bcachefs optional, copy fallback. Restore explicit and not activation. Known running jobs block mutable-state checkpoint/restore.
- Future feature requests must not create a globally mutable tab implementation. Copy starter source or pin shared dependencies per project.

## Gates

- Install graph: `pnpm install --frozen-lockfile`.
- Standard acceptance: `pnpm verify` = type/core check, native tests, native+web build, real network tests, ChromiumFish browser tests.
- Desktop: `pnpm appimage && pnpm test:desktop && pnpm test:desktop-update && pnpm test:desktop-interface`; real AppImages + graphical session. Runtime gate = temporary feed, corruption rejection + replacement/relaunch. Interface gate = native trust, selective transfer, same binary/PID, retained selection/terminal, failure/offline recovery. `node scripts/install-desktop.mjs` copies to versionless `desktop/installed/emachine.AppImage` + updates own launcher/menu entry.
- Installed deployment: `node scripts/check-installation.mjs`; optional additional live-client gate `node tests/desktop.mjs --configured` opens the seeded project's terminal without sending commands.
- Core edits: `cd core && moon info --target native && moon fmt`; preserve generated public interfaces. Pinned module graph owns async APIs.
- Regression tests need an observed failure on the pre-fix source. Preserve red command/source hash, keep grading check unchanged, record evidence in commit body.
- Tests use temporary project roots and clean exact fixture zmx sessions. User projects are not test fixtures.
- Final claimed gates rerun from committed source. Never label physical mobile, native snapshots, or public login verified without direct evidence.

## Deployment

- CachyOS = server/build/test host; desktop client runs on a separate user machine. Deliver AppImages through GitHub Releases. Desktop installation requires an explicitly named client target; CachyOS GUI gates use temporary profiles only. Preserve the local server, web deployment and project state during client packaging/removal.
- `scripts/install.mjs` guards owned files, validates systemd units, installs user service. `KillMode=process` preserves zmx across restarts. Core supervises ordinary workers.
- `scripts/seed-client.mjs` writes only machine identity/name/addresses to built `bootstrap.json`; no credentials. Native endpoint supplies dynamic bootstrap.
- PWA precaches allowlisted shell bytes only. API/bootstrap/terminal/source/results never enter its service-worker cache.
- Desktop UI delivery: `pnpm build:web` emits `ui-manifest.json` in the served web root; no runtime release needed. One native-approved HTTPS source (loopback HTTP allowed), metadata-only polling, manual verified refresh, fixed `emachine://app` origin/profile. Seeds stay bundled. Contract/recovery = `docs/interface-updates.md`.
- Interface bridge = `desktop/interface-manifest.cjs` owns the native compatibility version, path/size limits + canonical hashes. Native API/runtime requirements change → bump bridge and ship a runtime update. Serialize readiness/recovery pointer writes; keep staging outside cleanup races. `pnpm test:interface` owns these invariants and runs in `pnpm verify`.
- Public FreeBSD route not deployed. Caddy/PF changes were blocked. Keep its planned address out of live connection seeds until deployment succeeds.

## Releases

- Repository = `git@github.com:eturkes/emachine.git`; source/tag pushes use SSH. GitHub release API uses authenticated `gh`.
- `pnpm release:prepare` requires clean committed source; verifies, archives HEAD, builds isolated unseeded Linux x86-64 AppImage, tests exact artifact, emits `desktop/publish/vVERSION/{*.AppImage,SHA256SUMS,release.json,latest-linux.yml}`. Update metadata must match exact artifact/version. Updater = manual stable releases only; no automatic download, install-on-quit, or renderer-controlled feed.
- `EMACHINE_CLIENT_SEED=empty` must not read machine configuration. Release packaging must preserve the installed AppImage and exclude local identities, addresses, state and credentials.
- Version tags immutable; create annotated `vX.Y.Z` only at prepared `release.json.commit`. No forced push or asset clobber. Publish after upload/digest validation. Workflow = `docs/releases.md`.
