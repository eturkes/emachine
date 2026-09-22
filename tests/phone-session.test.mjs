import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { sessionAuthority, sessionLifetime, startSessionServer } from '../scripts/phone-session.mjs';
import { gatewayConfig } from '../scripts/phone-gateway.mjs';
import { ensureCaddy } from '../scripts/caddy.mjs';
import { fixture, freePort, until, root } from './network-helper.mjs';

const cookiePair = value => value.split(';')[0];
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

test('phone supervisor owns its socket and proxy; restart revokes sessions without stopping native', { timeout: 45000 }, async t => {
  const listenPort = await freePort(), publicUrl = `http://127.0.0.1:${listenPort}/`;
  const f = await fixture({ origins: [new URL(publicUrl).origin] }); t.after(() => f.close());
  const state = await f.state(), password = randomBytes(32).toString('base64url');
  const caddy = await ensureCaddy();
  const passwordHash = execFileSync(caddy, ['hash-password', '--algorithm', 'bcrypt'], { input: password + '\n', encoding: 'utf8' }).trim();
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
  assert.equal((await fetch(publicUrl, { headers: { Cookie } })).status, 401);
  assert.equal((await f.state()).machine.id, nativeBefore.machine.id);
  assert.equal((await restarted.stop())[0], 0);
  await writeFile(settings.sessionSocket, 'unowned file');
  const refused = start(); assert.equal((await refused.ended)[0], 1);
  assert.equal(await readFile(settings.sessionSocket, 'utf8'), 'unowned file');
});
