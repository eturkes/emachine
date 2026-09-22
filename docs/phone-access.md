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
3. Enter `emachine` and the generated password.
4. Confirm that the project list and a terminal work.
5. Select **Share**, then **Add to Home Screen**.

Create the icon from the public address. An existing icon for the private address still requires Tailscale.
The Home Screen app can request the password separately from Safari.

After a successful password check, the gateway creates a 12-hour browser session.
Subsequent requests use a protected cookie, including terminal and event connections.
This avoids repeated password challenges when a browser omits Basic authentication from WebSocket requests.
The password stays unchanged.

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
The gateway checks the complete Host authority, including its port.
It requires the exact browser origin for mutations and WebSockets.
It removes browser credentials, cookies, private session headers, and Tailscale identity headers before proxying.
Only the gateway supplies the separate upstream secret.
Credentials remain in owner-only files, outside source control and client bundles.

The public session cookie uses `Secure`, `HttpOnly`, `SameSite=Strict`, and a `__Host-` name.
Sessions contain random identifiers, not the password. The helper checks expiry on each new request.
The helper accepts requests only through an owner-only Unix socket with a separate internal credential check.
Caddy issues that internal assertion only after authenticating the password and checking the browser origin.
The helper keeps at most 256 sessions in memory. A gateway restart revokes every session.
Existing upgraded connections end when the gateway stops, but the underlying terminal sessions remain available.
The supervisor stops Caddy when the session helper fails. Authentication does not fall back to unprotected access.

The public client seed contains only this public address. It never attempts a private Tailscale connection.
The PWA caches shell assets only. It does not cache the client seed, API responses, or terminal output.

Run `pnpm test:gateway` for Caddy, native server, terminal, Chromium, and WebKit HTTPS and WebSocket checks.
The WebKit check also verifies service-worker readiness and reopening with only the session cookie.
The gate checks expiry, revocation, hostile cookies, internal assertions, Origin rejection, and supervisor ownership.
It also checks installation recovery, password consistency, process-lifetime locks, and foreground route ownership.
The gate prepares its pinned WebKit browser and compatibility libraries under `.tools/`. It does not install system packages.
It runs in `pnpm verify`.
Automated browser checks do not prove physical iPhone behavior or public Funnel reachability.
Verify both after approving and publishing the route.

| Review boundary | Required behavior |
| --- | --- |
| Authentication | Anonymous and incorrect-password HTTP and WebSocket requests fail before proxying. |
| Sessions | Unknown or altered identifiers fail. Cookies expire, stay outside JavaScript and upstream requests, and are revoked by gateway restart. |
| Host and Origin | The complete authority and browser origin match the configured public address. |
| Credentials | Browser credentials are stripped; the separate upstream secret stays outside client files. |
| Network | The gateway and its upstream use loopback; Funnel targets only the authenticated gateway. |
| Installation | Native jobs are not restarted; failed changes restore gateway files and service state. |
| Publication | Commands preserve unrelated routes and refuse foreground ownership on the public port. |
| Phone client | The seed uses only the public origin; dynamic responses never enter the PWA cache. |
| Check integrity | The Caddy archive is pinned; failure-path cleanup releases owned test resources. |

Funnel transport and approval follow the [Tailscale Funnel documentation](https://tailscale.com/docs/features/tailscale-funnel).
Gateway authentication follows the [Caddy authentication documentation](https://caddyserver.com/docs/caddyfile/directives/basic_auth).
