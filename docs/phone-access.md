# iPhone access without a VPN

The phone gateway gives Safari and the Home Screen app a password-protected HTTPS address.
The iPhone does not need Tailscale. The CachyOS server still uses Tailscale Funnel for the public connection.
This route does not require FreeBSD, router port forwarding, or a new domain.

## Prepare the gateway

Run these commands from the emachine checkout on CachyOS:

```sh
pnpm phone:install
pnpm phone:status
```

The installer downloads a pinned Caddy release and checks its archive checksum.
It creates a private gateway directory and the `emachine-phone.service` user service.
The gateway listens only on `127.0.0.1:4738`. Installation does not publish it.

The installer does not change the native server configuration or restart the native service.
The native server must already have its loopback origin and a separate gateway secret configured.
The gateway validates the public origin, then sends the native server its existing loopback origin and private secret.
Repeated installation retains the password and does not restart an unchanged gateway.
Failed reconfiguration restores the previous gateway files and service state.
An operating-system lock releases when its owner exits, including after a crash.

When a saved password file is missing, restore it before reinstalling.
The installer refuses to pair a replacement password with an existing hash.

The username is `emachine`. The installer prints the path to the generated password file.
Its default location is `~/.config/emachine/phone/password`.
Keep this password private. It grants access to the machine's projects and terminals.

## Publish the address

```sh
pnpm phone:enable
```

This command checks anonymous rejection and authenticated machine access before publishing anything.
It uses `sudo -n` for the scoped Tailscale command.
When Tailscale requests approval, open its approval link and approve Funnel for this machine.
The command must finish successfully before the public address is ready.

The phone address for this machine is:

```text
https://t25-480.tail23f28e.ts.net:8443/
```

Port `8443` belongs to this route. The installer refuses to replace another route on that port.
This includes foreground Funnel routes. Stop their owning process before using the phone commands.
The private address on port `4743` remains separate.
Never publish the unprotected machine port `4737` directly through Funnel.

## Install on iPhone

1. Turn off Tailscale on the iPhone.
2. Open the public address in Safari.
3. Enter the generated password on the sign-in page. The username is `emachine`.
4. Confirm that the project list and a terminal work.
5. Select **Share**, then **Add to Home Screen**.

Create the icon from the public address. An existing icon for the private address still requires Tailscale.
The Home Screen app can request the password separately from Safari.
The sign-in page opens inside the app. It does not require a browser authentication dialog.

After a successful password check, the gateway remembers this app with a protected cookie.
The session is valid for 90 days and renews silently once a day during authenticated use.
Regular use keeps the app signed in across app closes, gateway restarts, and updates.
Terminal and event connections use the same cookie. The password stays unchanged.

The first update from 12-hour sessions requires one more login because those sessions existed only in memory.
Sign-in is required again after expiry, explicit revocation, a configured password-hash change, or clearing the app's cookie.
If the session expires, reopen the app and enter the same password.
If an older app shows an empty download, close it from the app switcher and reopen it.
Do not download or open that file.

## Sign out or revoke remembered access

In the phone app, open **Settings**, then select **Sign out**.
This revokes the current app's credential for future requests, clears its cookie, and reloads the sign-in page.
Reloading closes this app's terminal and event connections. Other remembered devices remain signed in.

To revoke every remembered device and immediately disconnect all active phone gateway connections, run this on CachyOS:

```sh
pnpm phone:revoke
```

The command stops the phone service, clears its saved sessions, and restarts it only if it was running.
Revocation survives subsequent restarts. Native services and the underlying zmx sessions continue running.
Use this command if a device or cookie may have been lost: signing out one app cannot close an already-open connection elsewhere.

## Open the terminal keyboard

Tap **Keyboard** to type directly in the terminal. Tap it again to hide the keyboard.
Tap **Esc** beside it to send Escape to the terminal.
Tap **Tab** beside Esc for shell completion or the running program's Tab action.
All three buttons stay visible when you scroll the shortcut bar. Keyboard's pressed state marks active terminal input.
The other keys are grouped into arrows and key combinations: **Shift + Left**, **Ctrl-C**, **Ctrl-O**, **Ctrl-E**, and **Ctrl-X Ctrl-S**.
Connection messages and **Take control** appear above the controls when needed.
You can also tap the terminal once. Swipe vertically to scroll terminal history.
Short taps open the keyboard. To select text, use **Copy** in the toolbar.

On iPhone and iPad, the terminal uses smaller text to show more content.
The terminal disables double-tap zoom. You can still pinch to zoom.
Rotate the phone to show more columns. The terminal fits the available space when the keyboard opens or closes.
The arrow buttons preserve the keyboard's current state, so you can hide it and navigate a menu with more rows visible.
They also work when the session is already open in an SSH or desktop terminal. You do not need to type another key first.
Keyboard animations settle before the terminal sends its new dimensions to the running program.

## Choose a machine terminal session

Tap the machine name in the project drawer to open its terminals. Tap **+** to open the first available tab name in the sequence `misc1`, `misc2`, `misc3`, and so on. Closing a tab makes its name available again, including gaps between open tabs.

Long-press a terminal tab to open **Choose zmx session**. Enter the exact session name and select **Open session**. An existing session resumes with its shell state and working directory. A new session starts in the server user's home directory. Desktop users can double-click the tab or press F2 while it is focused. Choosing a session already open in another tab selects that tab.

Closing or switching a tab leaves its zmx session and running programs alive. Swipe the tab strip normally to reach other tabs; moving your finger cancels the long press.

## Copy terminal output

On a touchscreen, tap **Copy** in the text tools row below the terminal keys.
When no terminal text is already selected, this opens **Copy terminal output** with a selectable snapshot.
Press and hold the text to select a passage and adjust the native selection handles, then tap **Copy selection** or the device's **Copy** command.
Tap **Copy all** to copy the whole snapshot, including the available terminal scrollback.

The snapshot stays still while the terminal continues running. Close and reopen it to capture newer output.
Full-screen programs show their current screen; shell scrollback is available when the normal terminal screen is active.
Terminal-wrapped lines are joined when possible, while actual line breaks and printed spaces are preserved.

Copying works while observing another device's shell or while disconnected; it never sends terminal input.
If clipboard access is unavailable, the text stays selectable for the device's native **Copy** command.
Closing the view returns to the Copy button without opening the terminal keyboard.
Snapshots are discarded when closed, when switching away from their terminal, or when the page closes.

## Type with native spelling tools

On iPhone or iPad, select **Text** beside **Copy** and **Paste** in the text tools row.
Type in the **Terminal text** field and use the keyboard's spelling corrections.
Select **Send text** to paste the completed draft into the terminal.

The field enables native spell checking and autocorrection. It does not add automatic capitalization.
To enable system autocorrection, open **Settings > General > Keyboard** and turn on **Auto-Correction**.
The available corrections depend on your keyboard, language, and device settings.
See [Apple's autocorrection instructions](https://support.apple.com/104995).

Typing and pressing Return in the field only edit the draft. **Send text** does not add an Enter key.
Embedded line breaks follow normal terminal paste behavior. They can execute commands when the receiving program does not use bracketed paste.
To type commands without spelling changes, select **Keyboard**, select **Text** again, or tap the terminal directly.
The existing terminal keys and clipboard controls keep their normal behavior.

Send is unavailable during composition, observation, or disconnection.
Reconnecting does not send a draft. Select **Send text** when you are ready.
Each project keeps its own draft while its terminal remains mounted.
Hiding the field retains the draft. Reloading or closing the page discards it.
Emachine does not store drafts in browser storage or send them to a spelling service.

## Disable access

```sh
pnpm phone:disable
```

This removes only the phone's public route. It does not reset Tailscale or change the private route.
To stop active gateway connections as well, stop its service:

```sh
systemctl --user stop emachine-phone.service
```

The underlying zmx sessions continue running.

## Security and verification

Caddy requires authentication for the shell, client seed, assets, API, and WebSocket upgrades.
An unauthenticated HTML navigation receives a separate sign-in document, not the shell or project data.
The document has an explicit HTML content type and a restrictive content security policy.
It sends the password only in a same-origin POST authentication header. It does not store the password.
The session endpoint checks the password, complete authority, and exact Origin before issuing its cookie.
The gateway checks the complete Host authority, including its port.
It requires the exact browser origin for mutations and WebSockets.
It removes browser credentials, cookies, private session headers, and Tailscale identity headers before proxying.
Only the gateway supplies the separate upstream secret.
Credentials remain in owner-only files, outside source control and client bundles.

The public session cookie uses `Secure`, `HttpOnly`, `SameSite=Strict`, and a `__Host-` name.
Sessions contain random identifiers, not the password. The helper checks expiry on each new request.
The helper accepts requests only through an owner-only Unix socket with a separate internal credential check.
Caddy issues that internal assertion only after authenticating the password and checking the browser origin.
The helper keeps at most 256 sessions and persists only hashes of their random identifiers with expiry metadata.
Its default store is `~/.config/emachine/phone/sessions.json`, an owner-only file in the private phone directory.
Updates are atomic, and malformed or unsafe storage fails closed.
The store is bound to the public origin, password hash, and gateway secret; changing any of these invalidates remembered sessions.
Ordinary gateway restarts preserve valid sessions. Renewal happens only after the gateway's authority and Origin checks.
Existing upgraded connections end when the gateway stops, but the underlying terminal sessions remain available.
The supervisor stops Caddy when the session helper fails. Authentication does not fall back to unprotected access.

The public client seed contains only this public address. It never attempts a private Tailscale connection.
The PWA caches shell assets only. It does not cache the client seed, API responses, or terminal output.

Run `pnpm test:gateway` for Caddy, native server, terminal, Chromium, and WebKit HTTPS and WebSocket checks.
The browser checks enter the password through the sign-in form, without preconfigured browser credentials.
Chromium and WebKit checks expire a live session and sign in again through the installed service worker.
The WebKit check also verifies service-worker readiness and reopening with only the session cookie.
The gate checks persistent restart recovery, renewal, expiry, revocation, hostile cookies, internal assertions, Origin rejection, and supervisor ownership.
It also checks installation recovery, password consistency, process-lifetime locks, and foreground route ownership.
The gate prepares its pinned WebKit browser and compatibility libraries under `.tools/`. It does not install system packages.
It runs in `pnpm verify`.
Automated browser checks do not prove physical iPhone behavior or public Funnel reachability.
Verify both after approving and publishing the route.

| Review boundary | Required behavior |
| --- | --- |
| Authentication | Anonymous and incorrect-password HTTP and WebSocket requests fail before proxying. |
| Sessions | Unknown or altered identifiers fail. Protected cookies renew during use; hashed grants survive ordinary restarts and explicit revocation persists. |
| Revocation | Sign out rejects future use of that credential. `phone:revoke` clears all grants and ends active gateway connections without stopping native jobs. |
| Host and Origin | The complete authority and browser origin match the configured public address. |
| Credentials | Browser credentials are stripped; the separate upstream secret stays outside client files. |
| Network | The gateway and its upstream use loopback; Funnel targets only the authenticated gateway. |
| Installation | Native jobs are not restarted; failed changes restore gateway files and service state. |
| Publication | Commands preserve unrelated routes and refuse foreground ownership on the public port. |
| Phone client | The seed uses only the public origin; dynamic responses never enter the PWA cache. |
| Check integrity | The Caddy archive is pinned; failure-path cleanup releases owned test resources. |

Funnel transport and approval follow the [Tailscale Funnel documentation](https://tailscale.com/docs/features/tailscale-funnel).
Gateway authentication follows the [Caddy authentication documentation](https://caddyserver.com/docs/caddyfile/directives/basic_auth).
