# Refresh the desktop interface

The desktop interface can update separately from the AppImage. The AppImage still supplies Electron, native controls, and a recovery interface.
Desktop builds before `0.1.2` need one AppImage update to gain this loader.

## Choose the source once

Open **Refresh** in the desktop header. Enter your emachine server's base address in **Interface source**.
The first saved machine supplies a suggestion. The app does not trust that suggestion automatically.

Select **Use this source**. Read the native confirmation, then select **Trust source**.
Only trust a server you control. Its interface code can access your connected machines.
The source stays fixed when you switch projects or machines.

Use HTTPS for remote servers. HTTP is allowed only on `localhost`, `127.0.0.1`, or `[::1]`.
The address must not contain credentials, queries, fragments, encoded paths, or redirects.
The server must allow the `emachine://app` origin. An emachine server already supports this origin when installed through the provided installer.
Direct Tailscale access supplies network authentication. The loader does not send cookies or embed gateway credentials.

## Apply a UI change

The app checks a small manifest at startup and every minute while it runs.
A new revision highlights **Refresh**. A check does not download the interface or reload your window.

Save work in your open views. Select **Refresh**, then **Refresh interface**.
The client fetches changed files and reuses matching files from its local interface or bundled copy.
It verifies every file before opening the complete revision. The AppImage and application process stay unchanged.

Your saved connections, selected project, and preferences stay in the same desktop profile.
Server terminals and jobs keep running. The refreshed interface reconnects to them.
Unsaved text and other temporary state inside a view can be lost during a reload.

**Updates** remains separate. Use it for Electron, native integration, and desktop security updates.
A UI refresh does not update the machine server or its project views.
Project views continue to use their own activation workflow.

## Deploy interface changes

On the machine that supplies the interface, build the web files:

```sh
pnpm install --frozen-lockfile
pnpm build:web
```

The default installation serves `web/dist` directly. A successful web build therefore supplies the new interface without restarting the machine server.
For a different deployment, copy the complete built web directory to its configured `webRoot`.
Wait for deployment to finish before refreshing. A request during a build can fail; retry after the build finishes.
Ordinary UI changes need no AppImage build, GitHub release, or application version bump.
Pushing source code alone does not deploy web files to another machine.

The build emits `ui-manifest.json` after its static files. The manifest contains a content revision, a bridge version, and file sizes and SHA-256 hashes.
Machine seeds, service workers, private configuration, and project data stay outside this interface manifest.
The desktop always reads its optional machine seed from the original AppImage.

The bridge version describes the desktop API that the UI needs. An incompatible revision is rejected before activation.
When a UI change needs a different native API or runtime capability, update the bridge contract and desktop runtime together.
File hashes detect corruption. They do not provide an independent publisher signature or protect against malicious code from a trusted source.

## Offline use and recovery

Startup uses the last verified local interface without waiting for the source server.
A missing server or failed download leaves that interface available.
A candidate becomes the saved startup revision only after its application code reports successful initialization.
If initialization fails or times out, the loader restores the previous interface.

To return to the bundled interface, select **Use bundled interface** in the refresh dialog.
When that dialog is unavailable, press **Control+Shift+B**, then confirm the native recovery prompt.
The same command is in the native **Interface** menu. Press **Alt** to show that menu.
Recovery preserves your profile and stays selected after restarting the client.

A successful initialization does not prove that every view works. Use bundled recovery for a broken interface that has already initialized.
If the cache is not writable, the recovery interface still opens. Fix disk space or app data permissions, then reopen the app.
