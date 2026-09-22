import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod } from 'node:fs/promises';

export const sessionLifetime = 12 * 60 * 60 * 1000;
const maxSessions = 256;
export function sessionAuthority({ secure, now = Date.now }) {
  const name = secure ? '__Host-emachine-phone' : 'emachine-phone-local';
  const sessions = new Map();
  const tokenFrom = header => {
    if (typeof header !== 'string' || header.length > 8192) return undefined;
    const values = header.split(';').map(part => part.trim()).filter(part => part.startsWith(name + '='));
    return values.length === 1 ? values[0].slice(name.length + 1) : undefined;
  };
  function valid(header) {
    const token = tokenFrom(header);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token ?? '')) return false;
    const expiry = sessions.get(token);
    if (expiry === undefined) return false;
    if (expiry <= now()) { sessions.delete(token); return false; }
    return true;
  }
  return {
    name, valid,
    issue() {
      const time = now();
      for (const [token, expiry] of sessions) if (expiry <= time) sessions.delete(token);
      if (sessions.size >= maxSessions) return undefined;
      const token = randomBytes(32).toString('base64url');
      sessions.set(token, time + sessionLifetime);
      return `${name}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionLifetime / 1000}${secure ? '; Secure' : ''}`;
    },
    clear() { sessions.clear(); },
  };
}

export async function startSessionServer({ sessionSocket, gatewaySecret, publicUrl, now }) {
  if (typeof sessionSocket !== 'string' || !sessionSocket.startsWith('/') || Buffer.byteLength(sessionSocket) > 103 || /[\u0000-\u001f]/.test(sessionSocket)) throw new Error('A private Unix session socket is required.');
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(gatewaySecret ?? '')) throw new Error('A private session bridge credential is required.');
  const url = new URL(publicUrl);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('Sessions require HTTPS outside loopback.');
  const authority = sessionAuthority({ secure: url.protocol === 'https:', now });
  const key = Buffer.from(gatewaySecret);
  const server = createServer({ maxHeaderSize: 16384, requestTimeout: 5000, headersTimeout: 5000, keepAliveTimeout: 1000 }, (request, response) => {
    const supplied = Buffer.from(String(request.headers['x-emachine-session-key'] ?? ''));
    response.setHeader('Cache-Control', 'no-store');
    if (supplied.length !== key.length || !timingSafeEqual(supplied, key)) { response.writeHead(403).end(); return; }
    if (request.method !== 'GET') { response.writeHead(405).end(); return; }
    if (request.url === '/check') { response.writeHead(authority.valid(request.headers.cookie) ? 204 : 401).end(); return; }
    // Caddy overwrites this assertion after its own bcrypt authentication; no public route reaches this socket.
    if (request.url === '/issue' && request.headers['x-emachine-session-user'] === 'emachine') {
      const cookie = authority.issue();
      if (!cookie) { response.writeHead(503).end(); return; }
      response.setHeader('Set-Cookie', cookie); response.writeHead(204).end(); return;
    }
    response.writeHead(403).end();
  });
  server.maxConnections = 128;
  server.on('clientError', (_, socket) => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(sessionSocket, resolve); });
  let closing;
  const close = () => closing ??= (async () => { authority.clear(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); })();
  try { await chmod(sessionSocket, 0o600); } catch (error) { await close(); throw error; }
  return { server, close };
}
