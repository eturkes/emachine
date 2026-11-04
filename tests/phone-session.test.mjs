import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat, mkdtemp, rm, chmod, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { sessionAuthority, sessionLifetime, sessionRenewalInterval, startSessionServer } from '../scripts/phone-session.mjs';
import { gatewayConfig } from '../scripts/phone-gateway.mjs';
import { ensureCaddy } from '../scripts/caddy.mjs';
import { fixture, freePort, until, root } from './network-helper.mjs';

const cookiePair = value => value.split(';')[0];
const maxAge = value => Number(/(?:^|; )Max-Age=(\d+)(?:;|$)/.exec(value)?.[1]);
async function sessionStorage(t) {
  const directory = await mkdtemp(join(tmpdir(), 'emachine-sessions-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, sessionFile: join(directory, 'sessions.json'), credentialScope: randomBytes(32).toString('hex') };
}

test('sessions are bounded, opaque, expiring, and revocable', () => {
  let now = 1000;
  const sessions = sessionAuthority({ secure: true, now: () => now });
  const issued = Array.from({ length: 256 }, () => sessions.issue());
  assert.equal(new Set(issued).size, 256);
  assert.equal(sessions.issue(), undefined);
  assert.equal(sessions.valid(cookiePair(issued[0])), true);
  assert.equal(sessions.valid(cookiePair(issued[0]) + '; ' + cookiePair(issued[0])), false);
  for (const value of ['', 'bad', cookiePair(issued[0]) + 'x', 'x'.repeat(9000)]) assert.equal(sessions.valid(value), false);
  now += sessionLifetime;
  assert.equal(sessions.valid(cookiePair(issued[0])), false);
  const renewed = sessions.issue(); assert.ok(renewed);
  assert.equal(sessions.valid(cookiePair(renewed)), true);
  sessions.clear(); assert.equal(sessions.valid(cookiePair(renewed)), false);
});

test('remembered sessions survive recreation and persist only private token digests', async t => {
  const storage = await sessionStorage(t);
  let now = 1000;
  const options = { secure: true, now: () => now, ...storage };
  const sessions = sessionAuthority(options);
  const issued = sessions.issue(), Cookie = cookiePair(issued);
  const token = Cookie.slice(Cookie.indexOf('=') + 1);
  assert.equal(sessionLifetime, 90 * 24 * 60 * 60 * 1000);
  assert.equal(maxAge(issued), sessionLifetime / 1000);
  assert.match(issued, /^__Host-emachine-phone=/);
  for (const attribute of ['Path=/', 'HttpOnly', 'SameSite=Strict', 'Secure']) assert.ok(issued.includes(attribute));
  const stored = await readFile(storage.sessionFile, 'utf8');
  assert.ok(!stored.includes(token));
  assert.ok(stored.includes(createHash('sha256').update(token).digest('hex')));
  assert.equal((await stat(storage.sessionFile)).mode & 0o777, 0o600);
  assert.equal((await stat(storage.directory)).mode & 0o777, 0o700);
  sessions.close();
  now += 13 * 60 * 60 * 1000;
  const reopened = sessionAuthority(options);
  assert.equal(reopened.valid(Cookie), true);
  reopened.close();
  assert.equal(await readFile(storage.sessionFile, 'utf8'), stored);
});

test('daily renewal survives restart and a lost cookie response without extending read-only checks', async t => {
  const storage = await sessionStorage(t);
  let now = 1000;
  const options = { secure: true, now: () => now, ...storage };
  const sessions = sessionAuthority(options);
  const Cookie = cookiePair(sessions.issue());
  const original = await readFile(storage.sessionFile, 'utf8');
  const initialExpiry = now + sessionLifetime;
  assert.equal(sessionRenewalInterval, 24 * 60 * 60 * 1000);
  now += sessionRenewalInterval;
  assert.equal(sessions.valid(Cookie), true);
  assert.equal(await readFile(storage.sessionFile, 'utf8'), original);
  const lostResponse = sessions.renew(Cookie);
  assert.equal(cookiePair(lostResponse), Cookie);
  assert.equal(maxAge(lostResponse), sessionLifetime / 1000);
  const renewed = await readFile(storage.sessionFile, 'utf8');
  assert.notEqual(renewed, original);
  const renewedExpiry = now + sessionLifetime;
  now += 60000;
  const recovered = sessions.renew(Cookie);
  assert.equal(cookiePair(recovered), Cookie);
  assert.equal(maxAge(recovered), (renewedExpiry - now) / 1000);
  assert.equal(await readFile(storage.sessionFile, 'utf8'), renewed);
  assert.equal(sessions.renew(Cookie + '; ' + Cookie), undefined);
  sessions.close();
  const reopened = sessionAuthority(options);
  now = initialExpiry;
  assert.equal(reopened.valid(Cookie), true);
  now = renewedExpiry - 1;
  assert.equal(reopened.valid(Cookie), true);
  now = renewedExpiry;
  assert.equal(reopened.valid(Cookie), false);
  assert.equal(reopened.renew(Cookie), undefined);
  reopened.close();
  assert.equal(sessionAuthority(options).valid(Cookie), false);
});

test('device revocation and revoke-all remain effective after session authority recreation', async t => {
  const storage = await sessionStorage(t);
  const options = { secure: true, ...storage };
  const sessions = sessionAuthority(options);
  const first = cookiePair(sessions.issue()), second = cookiePair(sessions.issue());
  assert.equal(sessions.revoke(first + '; ' + first), false);
  assert.equal(sessions.valid(first), true);
  assert.equal(sessions.revoke(first), true);
  assert.equal(sessions.revoke(first), false);
  sessions.close();
  const reopened = sessionAuthority(options);
  assert.equal(reopened.valid(first), false);
  assert.equal(reopened.valid(second), true);
  reopened.clear();
  assert.equal(reopened.valid(second), false);
  reopened.close();
  const cleared = sessionAuthority(options);
  assert.equal(cleared.valid(first), false);
  assert.equal(cleared.valid(second), false);
  assert.ok(cleared.issue());
  cleared.close();
});

test('changing the credential scope invalidates remembered devices without resurrecting old grants', async t => {
  const storage = await sessionStorage(t);
  const options = { secure: true, ...storage };
  const sessions = sessionAuthority(options);
  const Cookie = cookiePair(sessions.issue());
  sessions.close();
  const changed = sessionAuthority({ ...options, credentialScope: randomBytes(32).toString('hex') });
  assert.equal(changed.valid(Cookie), false);
  changed.close();
  const restored = sessionAuthority(options);
  assert.equal(restored.valid(Cookie), false);
  restored.close();
});

test('malformed, oversized, linked, and nonprivate session stores fail closed without overwriting files', async t => {
  const storage = await sessionStorage(t);
  const options = { secure: true, ...storage };
  const sessions = sessionAuthority(options);
  sessions.issue(); sessions.close();
  const original = await readFile(storage.sessionFile, 'utf8');
  for (const invalid of ['{', '{}', 'null', '[]', ' '.repeat(1024 * 1024)]) {
    await writeFile(storage.sessionFile, invalid, { mode: 0o600 });
    assert.throws(() => sessionAuthority(options));
    assert.equal(await readFile(storage.sessionFile, 'utf8'), invalid);
  }
  await writeFile(storage.sessionFile, original, { mode: 0o600 });
  await chmod(storage.sessionFile, 0o644);
  assert.throws(() => sessionAuthority(options));
  assert.equal((await stat(storage.sessionFile)).mode & 0o777, 0o644);
  await chmod(storage.sessionFile, 0o600);
  await chmod(storage.directory, 0o755);
  assert.throws(() => sessionAuthority(options));
  await chmod(storage.directory, 0o700);
  const target = join(storage.directory, 'foreign.json');
  await writeFile(target, original, { mode: 0o600 });
  await rm(storage.sessionFile);
  await symlink(target, storage.sessionFile);
  assert.throws(() => sessionAuthority(options));
  assert.equal(await readFile(target, 'utf8'), original);
  await rm(storage.sessionFile);
  await writeFile(storage.sessionFile, original, { mode: 0o600 });
  for (const credentialScope of [undefined, '', 'not-a-digest', 'a'.repeat(63), 'A'.repeat(64)]) {
    assert.throws(() => sessionAuthority({ ...options, credentialScope }));
  }
});

test('FIFO session storage is rejected promptly without replacing the special file', { timeout: 10000 }, async t => {
  const storage = await sessionStorage(t);
  execFileSync('mkfifo', ['-m', '600', storage.sessionFile], { timeout: 3000 });
  const before = await stat(storage.sessionFile);
  assert.equal(before.isFIFO(), true);
  const script = `
    import assert from 'node:assert/strict';
    import { sessionAuthority } from ${JSON.stringify(new URL('../scripts/phone-session.mjs', import.meta.url).href)};
    assert.throws(() => sessionAuthority(${JSON.stringify({ secure: true, ...storage })}), /cannot be read safely|regular file/);
    process.stdout.write('rejected\\n');
  `;
  // A blocking open must fail this child deadline, not hang the test runner on the FIFO.
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 3000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'],
  }), 'rejected\n');
  const after = await stat(storage.sessionFile);
  assert.equal(after.isFIFO(), true);
  assert.equal(after.ino, before.ino);
  assert.equal(after.dev, before.dev);
  assert.equal(after.mode, before.mode);
});

test('failed persistence poisons the authority instead of accepting memory-only renewals or grants', async t => {
  const storage = await sessionStorage(t);
  let now = 1000;
  const options = { secure: true, now: () => now, ...storage };
  const sessions = sessionAuthority(options);
  const Cookie = cookiePair(sessions.issue());
  const original = await readFile(storage.sessionFile, 'utf8');
  now += sessionRenewalInterval;
  await chmod(storage.directory, 0o500);
  try {
    assert.throws(() => sessions.renew(Cookie));
    assert.equal(sessions.valid(Cookie), false);
    assert.throws(() => sessions.issue());
    assert.throws(() => sessions.renew(Cookie));
  } finally { await chmod(storage.directory, 0o700); }
  sessions.close();
  assert.equal(await readFile(storage.sessionFile, 'utf8'), original);
  const reopened = sessionAuthority(options);
  assert.equal(reopened.valid(Cookie), true);
  now = 1000 + sessionLifetime;
  assert.equal(reopened.valid(Cookie), false);
  reopened.close();
});

test('private session bridge requires its socket credential and authenticated issuer', async t => {
  const f = await fixture(); t.after(() => f.close());
  const sessionSocket = join(f.home, 'session.sock'), gatewaySecret = randomBytes(32).toString('hex');
  const bridge = await startSessionServer({ sessionSocket, gatewaySecret, publicUrl: 'https://fixture.example/' });
  t.after(() => bridge.close());
  assert.equal((await stat(sessionSocket)).mode & 0o777, 0o600);
  const call = (path, headers = {}) => new Promise((resolve, reject) => {
    const req = request({ socketPath: sessionSocket, path, headers }, res => { res.resume(); resolve({ status: res.statusCode, cookies: res.headers['set-cookie'] }); });
    req.on('error', reject); req.end();
  });
  assert.equal((await call('/issue', { 'X-Emachine-Session-User': 'emachine' })).status, 403);
  assert.equal((await call('/issue', { 'X-Emachine-Session-Key': gatewaySecret })).status, 403);
  const issued = await call('/issue', { 'X-Emachine-Session-Key': gatewaySecret, 'X-Emachine-Session-User': 'emachine' });
  assert.equal(issued.status, 204);
  assert.equal((await call('/check', { 'X-Emachine-Session-Key': gatewaySecret, Cookie: cookiePair(issued.cookies[0]) })).status, 204);
  assert.equal((await call('/check?ignored=1', { 'X-Emachine-Session-Key': gatewaySecret })).status, 403);
});

test('phone supervisor owns its socket and proxy; restart preserves sessions without stopping native', { timeout: 45000 }, async t => {
  const listenPort = await freePort(), publicUrl = `http://127.0.0.1:${listenPort}/`;
  const f = await fixture({ origins: [new URL(publicUrl).origin] }); t.after(() => f.close());
  const state = await f.state(), password = randomBytes(32).toString('base64url');
  const caddy = await ensureCaddy();
  // Exercise real bcrypt authentication without production-cost work on each fixture request.
  const passwordHash = execFileSync(caddy, ['hash-password', '--algorithm', 'bcrypt', '--bcrypt-cost', '4'], { input: password + '\n', encoding: 'utf8' }).trim();
  const settings = { publicUrl, listenPort, upstreamPort: f.port, gatewaySecret: f.config.gatewaySecret, machine: state.machine, passwordHash, sessionSocket: join(f.home, 'session.sock') };
  const settingsPath = join(f.home, 'settings.json'), configPath = join(f.home, 'caddy.json');
  await writeFile(settingsPath, JSON.stringify(settings), { mode: 0o600 });
  await writeFile(configPath, JSON.stringify(gatewayConfig(settings)), { mode: 0o600 });
  const processes = [];
  const start = () => {
    const child = spawn(process.execPath, [join(root, 'scripts/phone-runtime.mjs'), settingsPath, configPath], { env: { ...process.env, XDG_CONFIG_HOME: f.home, XDG_DATA_HOME: f.home }, stdio: ['ignore', 'pipe', 'pipe'] });
    const ended = once(child, 'exit'); child.stdout.resume(); child.stderr.resume();
    const managed = { child, ended, async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      try { return await ended; } finally { clearTimeout(timer); }
    } };
    processes.push(managed); return managed;
  };
  t.after(async () => { for (const process of processes) await process.stop(); });
  const first = start();
  await until(async () => (await fetch(publicUrl)).status === 401);
  const nativeBefore = await f.state();
  const duplicate = start(); assert.equal((await duplicate.ended)[0], 1);
  const login = await fetch(publicUrl, { headers: { Authorization: 'Basic ' + Buffer.from(`emachine:${password}`).toString('base64') } });
  assert.equal(login.status, 200);
  const Cookie = cookiePair(login.headers.get('set-cookie'));
  assert.equal((await fetch(publicUrl, { headers: { Cookie } })).status, 200);
  assert.equal((await first.stop())[0], 0);
  await assert.rejects(fetch(publicUrl));
  await assert.rejects(stat(settings.sessionSocket), { code: 'ENOENT' });
  const restarted = start();
  await until(async () => (await fetch(publicUrl)).status === 401);
  assert.equal((await fetch(publicUrl, { headers: { Cookie } })).status, 200);
  assert.equal((await f.state()).machine.id, nativeBefore.machine.id);
  assert.equal((await restarted.stop())[0], 0);
  await writeFile(settings.sessionSocket, 'unowned file');
  const refused = start(); assert.equal((await refused.ended)[0], 1);
  assert.equal(await readFile(settings.sessionSocket, 'utf8'), 'unowned file');
});
