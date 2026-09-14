# Optional FreeBSD gateway

## Current state

The direct server is running at `https://t25-480.tail23f28e.ts.net:4743/`. FreeBSD is not required for this route.

The planned public client is `https://eturkes.com/emachine/`. It has not been deployed. The connector blocked the proposed Caddy and PF changes. Existing hosting remains unchanged.

The reviewed host is `eturkes@192.168.40.50`, SSH port `9993`. Caddy runs in the `web-ingress` jail. Its configuration is under `/jails/web-ingress/usr/local/etc/caddy/`.

The existing `naoto_auth` snippet uses Basic Auth. Reusing it would give emachine the same username and password without introducing another identity service.

## Network prerequisite

The host can connect to `100.125.196.115:4743`. The jail cannot. Existing NAT covers the physical network interface, not `tailscale0`.

The proposed exception is restricted to the ingress jail, this machine, and the emachine port:

```pf
# Place beside the existing NAT rule after reviewing current addresses.
nat on tailscale0 inet proto tcp from $jail_ip to 100.125.196.115 port 4743 -> 100.65.0.116
```

Preserve the existing firewall rules and states. Validate any candidate with `pfctl -nf` before loading it. Keep a configuration backup and an active administrative connection.

## Caddy route

Keep the existing `eturkes.com` static site as a fallback handler. Add an authenticated `/emachine/*` handler that serves an independent copy of `web/dist/`.

Apply `naoto_auth` before both static files and machine proxy routes. Do not reuse the public site's restrictive content policy for the application shell. Do not add `X-Frame-Options: DENY` to feature responses.

The machine proxy must retain its route prefix:

```text
/emachine/m/3ce72e76b1b99dee52f31ab8d6c91f37/*
    -> https://100.125.196.115:4743/*
```

Configure TLS server-name verification as `t25-480.tail23f28e.ts.net`. This avoids the jail's unavailable tailnet DNS resolution without disabling certificate checks.

Strip the browser's `Authorization` header before proxying. Set `X-Emachine-Gateway` from the server's private `gatewaySecret`. Keep this value in a protected Caddy configuration file, never in the static client.

The machine server must allow the exact origin `https://eturkes.com`. The public route must reject unauthenticated requests before reaching any API or WebSocket endpoint.

After deployment, enable the gateway address in the machine configuration and rebuild the client seed. Keep the direct address as the preferred route.

## Acceptance

Verify the jail's upstream TLS connection, unauthenticated rejection, authenticated HTTP and WebSocket traffic, path-prefix preservation, and unchanged existing sites. Also verify direct client access with the gateway unavailable.

Keep public access disabled until these checks succeed. A static shell alone does not provide a route to private project servers.
