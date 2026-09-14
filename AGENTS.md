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
- Desktop: `pnpm appimage && pnpm test:desktop`; real AppImage + graphical session. `node scripts/install-desktop.mjs` updates own launcher/menu entry.
- Installed deployment: `node scripts/check-installation.mjs`; optional additional live-client gate `node tests/desktop.mjs --configured` opens the seeded project's terminal without sending commands.
- Core edits: `cd core && moon info --target native && moon fmt`; preserve generated public interfaces. Pinned module graph owns async APIs.
- Regression tests need an observed failure on the pre-fix source. Preserve red command/source hash, keep grading check unchanged, record evidence in commit body.
- Tests use temporary project roots and clean exact fixture zmx sessions. User projects are not test fixtures.
- Final claimed gates rerun from committed source. Never label physical mobile, native snapshots, or public login verified without direct evidence.

## Deployment

- `scripts/install.mjs` guards owned files, validates systemd units, installs user service. `KillMode=process` preserves zmx across restarts. Core supervises ordinary workers.
- `scripts/seed-client.mjs` writes only machine identity/name/addresses to built `bootstrap.json`; no credentials. Native endpoint supplies dynamic bootstrap.
- PWA precaches allowlisted shell bytes only. API/bootstrap/terminal/source/results never enter its service-worker cache.
- Public FreeBSD route not deployed. Caddy/PF changes were blocked. Keep its planned address out of live connection seeds until deployment succeeds.
