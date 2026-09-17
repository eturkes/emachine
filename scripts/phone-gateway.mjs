const port = value => {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('Use an integer port from 1 to 65535.');
  return value;
};

export function publicAddress(value) {
  const url = new URL(value);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('The public address must use HTTPS.');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use a root address without credentials, a query, or a fragment.');
  return url;
}

export function gatewayConfig({ publicUrl, listenPort, upstreamPort, upstreamOrigin, passwordHash, gatewaySecret, machine }) {
  const address = publicAddress(publicUrl);
  port(listenPort); port(upstreamPort);
  if (listenPort === upstreamPort) throw new Error('The gateway and machine server need separate ports.');
  if (upstreamOrigin !== undefined && upstreamOrigin !== `http://127.0.0.1:${upstreamPort}`) throw new Error('The upstream origin must match its loopback endpoint.');
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(gatewaySecret ?? '')) throw new Error('The gateway requires a separate, high-entropy upstream secret.');
  if (!/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(passwordHash ?? '')) throw new Error('The phone password must be a bcrypt hash.');
  if (!/^[a-z0-9-]{1,48}$/.test(machine?.id ?? '') || typeof machine.name !== 'string' || !machine.name || machine.name.length > 200 || /[{}\u0000-\u001f]/.test(machine.name)) throw new Error('The gateway requires a valid machine identity and name.');
  const origin = { header: { Origin: [address.origin] } };
  const response = (status, body = '') => ({ handler: 'static_response', status_code: status, body });
  const bootstrap = { servers: [{ id: machine.id, name: machine.name, direct: address.href }] };
  return {
    admin: { disabled: true, config: { persist: false } },
    logging: { logs: { default: { level: 'ERROR' } } },
    apps: { http: { servers: { phone: {
      listen: [`127.0.0.1:${listenPort}`],
      read_header_timeout: '10s', idle_timeout: '1m',
      automatic_https: { disable: true },
      routes: [
        { handle: [{ handler: 'headers', response: { set: {
          'Cache-Control': ['no-store'], 'Referrer-Policy': ['no-referrer'],
          'X-Content-Type-Options': ['nosniff'],
        }, delete: ['Server'] } }] },
        { match: [{ expression: `{http.request.hostport} != ${JSON.stringify(address.host)}` }], handle: [response(421)] },
        { handle: [{ handler: 'authentication', providers: { http_basic: {
          hash: { algorithm: 'bcrypt' }, realm: 'emachine',
          accounts: [{ username: 'emachine', password: passwordHash }],
        } } }] },
        // Basic credentials are ambient browser authority; require the exact origin for mutations and sockets.
        { match: [
          { header: { Origin: ['*'] }, not: [origin] },
          { method: ['POST', 'PUT', 'PATCH', 'DELETE', 'CONNECT'], not: [origin] },
          { header: { Upgrade: ['websocket'] }, not: [origin] },
        ], handle: [response(403)] },
        // A phone opened through this origin must never probe the private Tailscale endpoint.
        { match: [{ path: ['/bootstrap.json'], method: ['GET', 'HEAD'] }], handle: [{
          ...response(200, JSON.stringify(bootstrap)), headers: { 'Content-Type': ['application/json'] },
        }] },
        { handle: [{ handler: 'reverse_proxy',
          upstreams: [{ dial: `127.0.0.1:${upstreamPort}` }],
          transport: { protocol: 'http', dial_timeout: '5s', response_header_timeout: '30s' },
          headers: { request: {
            delete: ['Authorization', 'Tailscale-User-*', 'Tailscale-App-Capabilities'],
            // Validate the browser origin above, then use the existing native origin without restarting jobs.
            set: { Host: [`127.0.0.1:${upstreamPort}`], 'X-Emachine-Gateway': [gatewaySecret], ...(upstreamOrigin ? { Origin: [upstreamOrigin] } : {}) },
          }, response: { delete: ['Access-Control-Allow-*'] } },
        }] },
      ],
    } } } },
  };
}
