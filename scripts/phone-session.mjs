import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

export const sessionLifetime = 90 * 24 * 60 * 60 * 1000;
export const sessionRenewalInterval = 24 * 60 * 60 * 1000;
const maxSessions = 256;
const maxStoreBytes = 64 * 1024;
const digest = value => createHash('sha256').update(value).digest('hex');

export function sessionCredentialScope({ publicUrl, passwordHash, gatewaySecret }) {
  if (typeof passwordHash !== 'string' || !/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(passwordHash) || !/^[A-Za-z0-9_-]{32,128}$/.test(gatewaySecret ?? '')) throw new Error('The saved phone credentials are invalid.');
  return digest(JSON.stringify(['emachine-phone-sessions-v1', new URL(publicUrl).origin, passwordHash, gatewaySecret]));
}

function privateStore(sessionFile, credentialScope) {
  if (typeof sessionFile !== 'string' || !isAbsolute(sessionFile) || sessionFile.includes('\0') || !/^[a-f0-9]{64}$/.test(credentialScope ?? '')) throw new Error('A private session file and credential scope are required.');
  const directory = dirname(sessionFile), owner = process.getuid();
  const parent = lstatSync(directory);
  if (!parent.isDirectory() || parent.uid !== owner || (parent.mode & 0o077)) throw new Error('The session directory must be private and owned by this user.');
  const validate = info => {
    if (!info.isFile() || info.nlink !== 1 || info.uid !== owner || (info.mode & 0o777) !== 0o600) throw new Error('The session file must be an owner-only regular file.');
  };
  return {
    read() {
      let descriptor;
      try {
        descriptor = openSync(sessionFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const info = fstatSync(descriptor); validate(info);
        if (info.size > maxStoreBytes) throw new Error('The session file exceeds its limit.');
        const bytes = Buffer.alloc(maxStoreBytes + 1);
        let size = 0;
        while (size < bytes.length) {
          const count = readSync(descriptor, bytes, size, bytes.length - size, null);
          if (!count) break;
          size += count;
        }
        if (size > maxStoreBytes) throw new Error('The session file exceeds its limit.');
        const value = JSON.parse(bytes.subarray(0, size).toString('utf8'));
        if (value?.version !== 1 || !/^[a-f0-9]{64}$/.test(value.scope ?? '') || !Array.isArray(value.sessions) || value.sessions.length > maxSessions) throw new Error('The session file is invalid.');
        const sessions = new Map();
        for (const entry of value.sessions) {
          if (!Array.isArray(entry) || entry.length !== 2 || !/^[a-f0-9]{64}$/.test(entry[0]) || !Number.isSafeInteger(entry[1]) || entry[1] < 0 || sessions.has(entry[0])) throw new Error('The session file is invalid.');
          sessions.set(entry[0], entry[1]);
        }
        return { scope: value.scope, sessions };
      } catch (error) {
        if (descriptor === undefined && error.code === 'ENOENT') return undefined;
        throw new Error('The private session file cannot be read safely.', { cause: error });
      } finally { if (descriptor !== undefined) closeSync(descriptor); }
    },
    write(sessions) {
      // Rare login, daily renewal and revocation writes are durable before a cookie is acknowledged.
      const parentNow = lstatSync(directory);
      if (!parentNow.isDirectory() || parentNow.uid !== owner || (parentNow.mode & 0o077)) throw new Error('The session directory is no longer private.');
      try { validate(lstatSync(sessionFile)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const text = JSON.stringify({ version: 1, scope: credentialScope, sessions: [...sessions] }) + '\n';
      if (Buffer.byteLength(text) > maxStoreBytes || sessions.size > maxSessions) throw new Error('The session file exceeds its limit.');
      const temporary = sessionFile + '.pending-' + randomUUID();
      let descriptor, directoryDescriptor;
      try {
        descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        writeFileSync(descriptor, text); fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
        renameSync(temporary, sessionFile);
        directoryDescriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        fsyncSync(directoryDescriptor);
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
        if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
        try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    },
  };
}

export function clearStoredSessions({ sessionFile, credentialScope }) {
  privateStore(sessionFile, credentialScope).write(new Map());
}

export function sessionAuthority({ secure, now = Date.now, sessionFile, credentialScope }) {
  const name = secure ? '__Host-emachine-phone' : 'emachine-phone-local';
  const store = sessionFile === undefined ? undefined : privateStore(sessionFile, credentialScope);
  const saved = store?.read();
  let sessions = saved && saved.scope === credentialScope ? saved.sessions : new Map(), failed = false;
  if (saved && saved.scope !== credentialScope) store.write(sessions);
  const cookie = (token, expiry) => `${name}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor((expiry - now()) / 1000))}${secure ? '; Secure' : ''}`;
  const persist = candidate => {
    if (failed) throw new Error('Phone session storage is unavailable.');
    try { store?.write(candidate); sessions = candidate; }
    catch (error) { failed = true; sessions.clear(); throw new Error('Phone session storage is unavailable.', { cause: error }); }
  };
  const tokenFrom = header => {
    if (typeof header !== 'string' || header.length > 8192) return undefined;
    const values = header.split(';').map(part => part.trim()).filter(part => part.startsWith(name + '='));
    return values.length === 1 ? values[0].slice(name.length + 1) : undefined;
  };
  function lookup(header) {
    if (failed) return undefined;
    const token = tokenFrom(header);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token ?? '')) return undefined;
    const key = digest(token), expiry = sessions.get(key);
    if (expiry === undefined) return undefined;
    if (expiry <= now()) { sessions.delete(key); return undefined; }
    return { token, key, expiry };
  }
  return {
    name,
    valid(header) { return lookup(header) !== undefined; },
    issue() {
      if (failed) throw new Error('Phone session storage is unavailable.');
      const time = now();
      const candidate = new Map([...sessions].filter(([, expiry]) => expiry > time));
      if (candidate.size >= maxSessions) return undefined;
      const token = randomBytes(32).toString('base64url');
      candidate.set(digest(token), time + sessionLifetime); persist(candidate);
      return cookie(token, time + sessionLifetime);
    },
    renew(header) {
      if (failed) throw new Error('Phone session storage is unavailable.');
      const session = lookup(header);
      if (!session) return undefined;
      const time = now();
      if (time >= session.expiry - sessionLifetime + sessionRenewalInterval) {
        session.expiry = time + sessionLifetime;
        const candidate = new Map([...sessions].filter(([, expiry]) => expiry > time));
        candidate.set(session.key, session.expiry); persist(candidate);
      }
      // Reissue even without a disk write so a dropped renewal response cannot strand the browser.
      return cookie(session.token, session.expiry);
    },
    revoke(header) {
      if (failed) throw new Error('Phone session storage is unavailable.');
      const session = lookup(header);
      if (!session) return false;
      const candidate = new Map(sessions); candidate.delete(session.key); persist(candidate); return true;
    },
    expiredCookie() { return cookie('', 0); },
    clear() { persist(new Map()); },
    close() { sessions.clear(); failed = true; },
  };
}

export async function startSessionServer({ sessionSocket, gatewaySecret, publicUrl, passwordHash, sessionFile, now }) {
  if (typeof sessionSocket !== 'string' || !sessionSocket.startsWith('/') || Buffer.byteLength(sessionSocket) > 103 || /[\u0000-\u001f]/.test(sessionSocket)) throw new Error('A private Unix session socket is required.');
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(gatewaySecret ?? '')) throw new Error('A private session bridge credential is required.');
  const url = new URL(publicUrl);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('Sessions require HTTPS outside loopback.');
  const authority = sessionAuthority({ secure: url.protocol === 'https:', now, sessionFile, credentialScope: sessionFile === undefined ? undefined : sessionCredentialScope({ publicUrl, passwordHash, gatewaySecret }) });
  const key = Buffer.from(gatewaySecret);
  const server = createServer({ maxHeaderSize: 16384, requestTimeout: 5000, headersTimeout: 5000, keepAliveTimeout: 1000 }, (request, response) => {
    const supplied = Buffer.from(String(request.headers['x-emachine-session-key'] ?? ''));
    response.setHeader('Cache-Control', 'no-store');
    if (supplied.length !== key.length || !timingSafeEqual(supplied, key)) { response.writeHead(403).end(); return; }
    if (request.method !== 'GET') { response.writeHead(405).end(); return; }
    try {
      if (request.url === '/check') { response.writeHead(authority.valid(request.headers.cookie) ? 204 : 401).end(); return; }
      if (request.url === '/renew') {
        const cookie = authority.renew(request.headers.cookie);
        if (!cookie) { response.writeHead(401).end(); return; }
        response.setHeader('Set-Cookie', cookie); response.writeHead(204).end(); return;
      }
      if (request.url === '/revoke') {
        authority.revoke(request.headers.cookie);
        response.setHeader('Set-Cookie', authority.expiredCookie()); response.writeHead(204).end(); return;
      }
      // Caddy overwrites this assertion after its own bcrypt authentication; no public route reaches this socket.
      if (request.url === '/issue' && request.headers['x-emachine-session-user'] === 'emachine') {
        const cookie = authority.issue();
        if (!cookie) { response.writeHead(503).end(); return; }
        response.setHeader('Set-Cookie', cookie); response.writeHead(204).end(); return;
      }
      response.writeHead(403).end();
    } catch {
      response.writeHead(503).end();
    }
  });
  server.maxConnections = 128;
  server.on('clientError', (_, socket) => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(sessionSocket, resolve); });
  let closing;
  const close = () => closing ??= (async () => { authority.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); })();
  try { await chmod(sessionSocket, 0o600); } catch (error) { await close(); throw error; }
  return { server, close };
}
