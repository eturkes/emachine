# emachine

A personal project command center with a MoonBit machine server, a browser application, an installable PWA, and a Linux AppImage.

Each machine owns its projects. Clients combine the project lists without connecting the servers to each other. Every project starts with a persistent terminal. Codexify adds and changes that project's views as needed.

## Open the application

Download the Linux x86-64 AppImage and `SHA256SUMS` from [GitHub Releases](https://github.com/eturkes/emachine/releases/latest).
Release builds start with an empty machine list. Add your machine's direct Tailscale address in **Machines**.
The AppImage is a client; run the MoonBit server separately on each project machine.

```sh
mv emachine-0.1.1-x86_64.AppImage emachine.AppImage
chmod +x emachine.AppImage
./emachine.AppImage
# Without a FUSE mount helper:
APPIMAGE_EXTRACT_AND_RUN=1 ./emachine.AppImage
```

On this workstation, run `emachine-app` or select **emachine** in the application menu.

In updater-enabled builds, select **Updates**, then **Check for updates**.
Select **Download update**, then **Restart and install**. Updates never install automatically when you close the app.
This updates only the desktop client, not machine servers or project views.
Version `0.1.0` requires one manual replacement to get these controls. Keep the new AppImage in a writable folder.
Rename it to `emachine.AppImage` before creating a shortcut, so the filename stays stable across updates.

For direct browser or phone access, connect Tailscale and open:

```text
https://t25-480.tail23f28e.ts.net:4743/
```

On iPhone, open this address in Safari and use **Share → Add to Home Screen**. On Android, use the browser's installation command.

The direct route uses your Tailscale identity. It does not require another emachine login. The existing service on port 443 remains unchanged.

The optional public route on FreeBSD is **not deployed**. Its jail needs a scoped Tailscale routing change and an authenticated Caddy route. See [the deployment notes](docs/public-gateway.md). The client already supports a separate gateway address for each machine.

## Work with projects

Emachine scans the immediate directories under `~/Projects/` once per second. Adding or removing a directory updates connected clients. A renamed directory retains its identity when its filesystem identity is unchanged.

Open a project to create or attach its zmx session. Switching projects or tabs does not close the shell. Closing the application disconnects its attachment, not the session.

The first connected device controls the terminal. Other devices observe the same screen until you select **Take control**. The controlling device sets the terminal dimensions.

The shell survives an emachine service restart. It does not survive an operating-system reboot. Input entered after a detected disconnection is discarded, never queued for replay.

Use **Machines** to add another server's direct address and optional gateway address. Each server must allow the client's exact origin. The desktop origin is `emachine://app`.

## Ask Codexify for a view

Feature source belongs to the selected project's external emachine workspace. Nothing is installed inside that project's directory.

```sh
emachine projects
emachine feature create cement pipeline "Pipeline"
emachine feature path cement pipeline
```

Codexify edits the returned workspace. Before changing an existing feature, take a source checkpoint:

```sh
emachine feature begin cement pipeline
```

Then validate and activate the completed change:

```sh
emachine feature activate cement pipeline
emachine diagnostics cement
```

Only that project's changed view reloads. A failed build leaves the active release available and retains the candidate source and diagnostics.

```sh
emachine feature remove cement pipeline
emachine feature checkpoint cement pipeline
emachine feature checkpoints cement pipeline
emachine feature restore cement pipeline CHECKPOINT_ID
```

Removing a view retains its workspace, results, and release history. Restoring a checkpoint does not activate it. Review the restored source, then activate it explicitly.

Views can contain arbitrary interfaces and declared server actions. They are trusted code with your normal account permissions. Read [the feature guide](docs/features.md) before adding a worker or persistent state.

## Storage and recovery

| Content | Default location |
| --- | --- |
| Application checkout | `~/.local/app/emachine/` |
| Configuration | `~/.config/emachine/config.json` |
| Feature source, releases, checkpoints | `~/.local/share/emachine/` |
| Job records, artifacts, mutable state | `~/.local/state/emachine/` |
| zmx sockets and server lock | `$XDG_RUNTIME_DIR/emachine-runtime/` |

The server rejects storage roots that overlap the managed project root. XDG variables and configuration can change these defaults.

The installer enables automatic snapshot selection for new emachine-owned boundaries. The bcachefs adapter attempts native subvolumes and snapshots. Unsupported or denied operations fall back to reflink-capable copies. Checkpoint records identify the backend actually used.

Native bcachefs snapshots have not been exercised on this installation. Copy-based recovery has automated coverage. Checkpoints are not independent backups and cannot undo terminal commands, external service calls, or changes to managed projects.

## Service and builds

```sh
systemctl --user status emachine
systemctl --user restart emachine
journalctl --user -u emachine -n 80

cd ~/.local/app/emachine
pnpm install --frozen-lockfile
pnpm verify
pnpm appimage
pnpm test:desktop
```

The core uses MoonBit's native backend and the pinned module dependencies. This checkout was built with MoonBit `0.1.20260904`. Required host tools include zmx, OpenSSL development libraries, a C compiler, Node.js, and pnpm. Browser tests use ChromiumFish. The AppImage test needs a working graphical session.

To install the server on another Linux machine, build it first, then run:

```sh
node scripts/install.mjs --direct https://MACHINE.TAILNET.ts.net:4743/
sudo tailscale serve --bg --https=4743 http://127.0.0.1:4737
pnpm appimage
node scripts/install-desktop.mjs
```

Review the exact allowed origins in the generated configuration before connecting another client. Enable user lingering when the service must run without an interactive login.

AppImage output: `desktop/release/emachine-VERSION-x86_64.AppImage`. The local installer copies it to `desktop/installed/emachine.AppImage`.
The desktop launcher uses this stable path and extraction mode. It does not depend on a FUSE mount helper.

To prepare a GitHub release, use `pnpm release:prepare`. It verifies committed source and builds an isolated, unseeded AppImage.
See [the release workflow](docs/releases.md) for SSH pushes, release assets, and checksum verification.

## Verification boundaries

Automated checks exercise real MoonBit servers, real zmx sessions, browser reconnection, independent feature activation, and the packaged desktop client. Fixtures use temporary project directories.

Phone-sized Chromium testing does not replace testing on physical iPhone or Android devices. Public gateway login, native bcachefs snapshots, and future media input remain outside the completed acceptance checks.
