# emachine

## Scope

- Personal Linux machine daemon = MoonBit native. Browser shell = TypeScript/DOM/xterm. Desktop = isolated Electron AppImage. No server federation.
- Source checkout outside managed projects. Discovery = immediate project-root directories. Emachine-owned files always outside managed projects.
- Initial project = lazy zmx terminal. Feature identity `(machine, project, feature)`; source/state/releases independently owned. `terminal` reserved.
- Terminal session = exact project name + inherited zmx namespace; reuse manual SSH sessions. Existing sessions retain shell state/cwd. Renames affect new attachments; preserve older sessions.
- Maintain terminal/process lifetime independently of browser component lifetime. Disconnected input is dropped; reconnect never replays uncertain input.
- Direct Tailscale owner access; exact Origin checks. Public gateway needs independent browser authentication + private upstream credential. Secrets stay out of code, bundles, URLs, logs.
- Feature code trusted, normal account permissions. Arbitrary interfaces/actions allowed; subprocess boundaries provide fault isolation, not a security sandbox.
- Header = text controls + view titles; route details in Settings, disconnection in the offline banner. AppImage upgrades = external GitHub Releases; no built-in updater. Interface refresh remains independent.
- Theme = persisted light/dark; environment resolves missing/legacy preferences once. Desktop rail stays expanded; phone drawer remains. No project/path or live-shell strips; exceptional terminal status + control share the shortcut bar.
- Shell + default feature styling = neutral grayscale in both themes, including text, surfaces, controls, selection, focus, terminal defaults + launcher icons. Accent tokens mean neutral emphasis. Use chromatic colors only for labeled functional states, warnings/errors, or data distinctions; keep semantic tokens separate from controls. Match the parent theme; copy/pin styles per feature. Apply this default to every new feature unless explicitly overridden.

## Feature iteration

- `emachine feature create PROJECT ID TITLE` → external workspace. `feature begin` → source checkpoint. Edit there; `feature activate` → checked release + project-local activation.
- Failed candidate retains source/diagnostics; active release unchanged. Update only affected frame. Independent terminal/frame instances stay mounted.
- Model-backed analysis = manual by default. Preserve artifacts and mark stale. Explicit cheap automatic analyze actions only; one attempt per revision/input fingerprint.
- Checkpoint = emachine-owned boundaries only. Backend recorded; native bcachefs optional, copy fallback. Restore explicit and not activation. Known running jobs block mutable-state checkpoint/restore.
- Future feature requests must not create a globally mutable tab implementation. Copy starter source or pin shared dependencies per project.

## Gates

- Install graph: `pnpm install --frozen-lockfile`.
- Standard acceptance: `pnpm verify` = type/core check, native tests, native+web build, real network tests, ChromiumFish browser tests.
- Phone gateway: `pnpm test:gateway` = real Caddy authentication/authority/Origin/WS boundaries + native inventory/events/terminal + Chromium/PWA + WebKit HTTPS/WSS and cookie-only reload + session expiry/revocation/socket ownership + install rollback/password/flock/foreground ownership. Included in `pnpm verify`. Caddy pin = `scripts/caddy.mjs`; WebKit setup + pinned Arch compatibility libraries = `scripts/setup-webkit.mjs`; caches = ignored `.tools/`.
- Desktop: `pnpm appimage && pnpm test:desktop && pnpm test:desktop-interface`; real AppImages + graphical session. Runtime gate = isolated renderer, absent app-updater bridge/dependency, real server + terminal. Interface gate = native trust, selective transfer, same binary/PID, retained selection/terminal, failure/offline recovery. `node scripts/install-desktop.mjs` copies to versionless `desktop/installed/emachine.AppImage` + updates own launcher/menu entry.
- Installed deployment: `node scripts/check-installation.mjs`; `--terminal PROJECT` additionally proves reuse of an existing manual zmx daemon without sending input. Optional live-client gate `node tests/desktop.mjs --configured` opens the seeded project's terminal without sending commands.
- Core edits: `cd core && moon info --target native && moon fmt`; preserve generated public interfaces. Pinned module graph owns async APIs.
- Regression tests need an observed failure on the pre-fix source. Preserve red command/source hash, keep grading check unchanged, record evidence in commit body.
- Theme gate = `pnpm test:web`; neutral surface/contrast, SDK/authentication, pixel-level icons + starter propagation. `tests/theme-contract.mjs` can be copied into independent feature gates. Icon replay = `node scripts/icons.mjs && git diff --exit-code -- web/public/icons/`; tracked PNG bytes must remain identical.
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
- Phone access: `pnpm phone:install` → protected loopback Caddy; validate public Origin before mapping to existing native loopback Origin + gateway secret. Never rewrite/restart native. `phone:enable` → preflight + explicit Funnel approval on dedicated 8443; `phone:disable` → that port alone; foreground occupancy → refuse. Keep private 4743 unchanged. Password/secret/config = owner-only `config-dir/phone/`; public bootstrap contains its own origin only. Contract + iPhone steps = `docs/phone-access.md`.
- Phone sessions: Caddy bcrypt login → opaque 12-hour cookie; Unix-socket helper validates bounded in-memory sessions. Production cookie = `__Host-`, Secure, HttpOnly, SameSite=Strict. Issue only after password + Origin checks; strip cookies/private bridge headers upstream. `phone-runtime.mjs` owns Caddy + helper under one service/lifetime lock; restart revokes sessions, native remains independent. Installer probes cookie-only access and fingerprints runtime source to restart changed code.

## Releases

- Repository = `git@github.com:eturkes/emachine.git`; source/tag pushes use SSH. GitHub release API uses authenticated `gh`.
- `pnpm release:prepare` requires clean committed source; verifies, archives HEAD, builds isolated unseeded Linux x86-64 AppImage, tests exact artifact, emits `desktop/publish/vVERSION/{*.AppImage,SHA256SUMS,release.json,latest-linux.yml}`. Keep release metadata for external update tools + older clients; metadata must match exact artifact/version.
- `EMACHINE_CLIENT_SEED=empty` must not read machine configuration. Release packaging must preserve the installed AppImage and exclude local identities, addresses, state and credentials.
- Version tags immutable; create annotated `vX.Y.Z` only at prepared `release.json.commit`. No forced push or asset clobber. Publish after upload/digest validation. Workflow = `docs/releases.md`.
