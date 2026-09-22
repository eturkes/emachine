import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { chromium } from '@playwright/test';
import WebSocket, { WebSocketServer } from 'ws';
import { ensureCaddy } from '../scripts/caddy.mjs';
import { fixture, freePort, until, root, socket } from './network-helper.mjs';

const password = randomBytes(32).toString('base64url');
const authorization = 'Basic ' + Buffer.from(`emachine:${password}`).toString('base64');
const caddy = await ensureCaddy();
const passwordHash = execFileSync(caddy, ['hash-password', '--algorithm', 'bcrypt'], { input: password + '\n', encoding: 'utf8' }).trim();
const implementation = () => import('../scripts/phone-gateway.mjs');

async function stop(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  await exited; clearTimeout(timer);
}
async function gateway(options, t) {
  const { gatewayConfig } = await implementation();
  const config = gatewayConfig({ passwordHash, ...options });
  const home = await mkdtemp(join(tmpdir(), 'emachine-gateway-test-'));
  let child, closing;
  const close = () => closing ??= (async () => { if (child) await stop(child); await rm(home, { recursive: true, force: true }); })();
  t?.after(close);
  t?.signal.addEventListener('abort', () => { void close(); }, { once: true });
  try {
  const path = join(home, 'caddy.json');
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  child = spawn(caddy, ['run', '--config', path], { env: { ...process.env, XDG_DATA_HOME: home, XDG_CONFIG_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', () => {});
  let logs = '';
  child.stdout.on('data', bytes => { logs += bytes; }); child.stderr.on('data', bytes => { logs += bytes; });
  const origin = `http://127.0.0.1:${options.listenPort}`;
  // Node fetch drops Host overrides; use the wire API so hostile-host cases reach Caddy unchanged.
  const request = (path = '', init = {}) => new Promise((resolve, reject) => {
    const req = httpRequest(`${origin}/${path}`, { method: init.method, headers: init.headers, timeout: 10000 }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Gateway request timed out.')));
    req.end(init.body);
  });
    await until(async () => {
      if (t?.signal.aborted) throw new Error('Gateway test was cancelled.');
      if (child.exitCode !== null) throw new Error(logs);
      return (await request()).status === 401;
    });
  return { origin, request, config, get logs() { return logs; }, close };
  } catch (error) { await close(); throw error; }
}
async function rejection(url, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url.replace(/^http/, 'ws'), { headers, handshakeTimeout: 5000 });
    ws.on('error', reject);
    ws.on('open', () => { ws.terminate(); reject(new Error('An unauthorized WebSocket opened.')); });
    ws.on('unexpected-response', (_, response) => { response.resume(); resolve(response.statusCode); ws.terminate(); });
  });
}

test('gateway configuration rejects unsafe addresses, secrets, and interpolation', async () => {
  const { gatewayConfig } = await implementation();
  const valid = { publicUrl: 'https://phone.example:8443/', listenPort: 4738, upstreamPort: 4737, passwordHash, gatewaySecret: randomBytes(32).toString('hex'), machine: { id: 'fixture', name: 'My machine' } };
  const config = gatewayConfig(valid);
  assert.deepEqual(config.apps.http.servers.phone.listen, ['127.0.0.1:4738']);
  assert.equal(config.admin.disabled, true);
  for (const publicUrl of ['http://phone.example/', 'https://user:pass@phone.example/', 'https://phone.example/path/', 'https://phone.example/?key=secret', 'https://phone.example/#secret', 'file:///tmp/']) {
    assert.throws(() => gatewayConfig({ ...valid, publicUrl }), undefined, publicUrl);
  }
  for (const field of ['listenPort', 'upstreamPort']) for (const value of [0, -1, 65536, 4.5, '4737']) assert.throws(() => gatewayConfig({ ...valid, [field]: value }));
  for (const value of ['', 'short', '{env.HOME}', 'x'.repeat(256)]) assert.throws(() => gatewayConfig({ ...valid, gatewaySecret: value }));
  assert.throws(() => gatewayConfig({ ...valid, passwordHash: 'plaintext' }));
  assert.throws(() => gatewayConfig({ ...valid, machine: { id: '../escape', name: 'Bad' } }));
  assert.throws(() => gatewayConfig({ ...valid, machine: { id: 'fixture', name: '{env.HOME}' } }));
});

test('real Caddy authenticates every route and strips client trust headers', { timeout: 45000 }, async t => {
  await implementation();
  const received = [];
  const upstream = createServer((req, res) => { received.push(req.headers); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ path: req.url, method: req.method, headers: req.headers })); });
  let g, sockets, closing;
  const close = () => closing ??= (async () => {
    for (const ws of sockets?.clients ?? []) ws.terminate();
    sockets?.close(); await g?.close();
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  })();
  t.after(close); t.signal.addEventListener('abort', () => { void close(); }, { once: true });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const listenPort = await freePort(), publicUrl = `http://127.0.0.1:${listenPort}/`;
  const gatewaySecret = randomBytes(32).toString('hex');
  try {
    g = await gateway({ publicUrl, listenPort, upstreamPort: upstream.address().port, gatewaySecret, machine: { id: 'fixture', name: 'Fixture' } }, t);
    for (const path of ['', 'bootstrap.json', 'manifest.webmanifest', 'sw.js', 'icons/512.png', 'api/v1/state', 'api/v1/jobs', 'api/v1/events', 'api/v1/terminal', 'features/fixture/index.html', 'missing']) {
      for (const Authorization of [undefined, 'Basic ' + Buffer.from('emachine:wrong').toString('base64')]) {
        const headers = { 'Tailscale-User-Login': 'fixture-owner', 'X-Emachine-Gateway': gatewaySecret, 'X-Forwarded-For': '127.0.0.1' };
        if (Authorization) headers.Authorization = Authorization;
        const response = await g.request(path, { headers });
        assert.equal(response.status, 401, path);
        assert.match(response.headers.get('www-authenticate'), /Basic/);
        assert.equal(response.headers.get('cache-control'), 'no-store');
      }
    }
    assert.equal(received.length, 0);
    const headers = { Authorization: authorization, Origin: g.origin };
    assert.equal((await g.request('api/v1/state', { headers: { ...headers, Origin: 'https://attacker.example' } })).status, 403);
    assert.equal((await g.request('api/v1/jobs', { method: 'POST', headers: { Authorization: authorization } })).status, 403);
    assert.equal((await g.request('api/v1/state', { headers: { ...headers, Host: 'attacker.example' } })).status, 421);
    const response = await g.request('api/v1/jobs?limit=2', { method: 'POST', headers: { ...headers, 'Tailscale-User-Login': 'forged', 'X-Emachine-Gateway': 'forged' }, body: '{}' });
    assert.equal(response.status, 200);
    const echo = await response.json();
    assert.equal(echo.path, '/api/v1/jobs?limit=2');
    assert.equal(echo.headers.authorization, undefined);
    assert.equal(echo.headers['tailscale-user-login'], undefined);
    assert.equal(echo.headers['x-emachine-gateway'], gatewaySecret);
    assert.equal(echo.headers.origin, g.origin);
    const bootstrap = await (await g.request('bootstrap.json', { headers })).json();
    assert.deepEqual(bootstrap.servers, [{ id: 'fixture', name: 'Fixture', direct: publicUrl }]);
    assert.ok(!JSON.stringify(bootstrap).includes(gatewaySecret));
    assert.ok(!g.logs.includes(gatewaySecret) && !g.logs.includes(password) && !g.logs.includes(authorization));
    sockets = new WebSocketServer({ server: upstream });
    sockets.on('connection', ws => ws.send('authenticated'));
    assert.equal(await rejection(g.origin + '/api/v1/events', { Origin: g.origin }), 401);
    assert.equal(await rejection(g.origin + '/api/v1/events', { Authorization: authorization }), 403);
    assert.equal(await rejection(g.origin + '/api/v1/events', { ...headers, Origin: 'https://attacker.example' }), 403);
    const ws = new WebSocket(g.origin.replace('http', 'ws') + '/api/v1/events', { headers });
    const message = once(ws, 'message');
    await once(ws, 'open'); assert.equal(String((await message)[0]), 'authenticated');
    const closed = once(ws, 'close'); ws.close(); await closed;
    sockets.close();
  } finally { await close(); }
});

test('phone-sized browser reaches real inventory, events, terminal, and PWA without a private route', { timeout: 60000 }, async t => {
  await implementation();
  const listenPort = await freePort(), publicUrl = `http://127.0.0.1:${listenPort}/`;
  const f = await fixture({ origins: [new URL(publicUrl).origin] });
  let browser, terminal, events, g, closing;
  const close = () => closing ??= (async () => { await events?.close(); await terminal?.close(); await browser?.close(); await g?.close(); await f.close(); })();
  t.after(close); t.signal.addEventListener('abort', () => { void close(); }, { once: true });
  const state = await f.state();
  try {
    g = await gateway({ publicUrl, listenPort, upstreamPort: f.port, gatewaySecret: f.config.gatewaySecret, machine: state.machine }, t);
    const headers = { Authorization: authorization, Origin: g.origin };
    const result = await (await g.request('api/v1/state', { headers })).json();
    assert.equal(result.machine.id, state.machine.id);
    events = await socket({ origin: g.origin }, 'api/v1/events', { Authorization: authorization });
    await until(() => events.packets.some(packet => packet.type === 'inventory')); await events.close();
    const project = state.projects.find(project => project.name === 'alpha');
    terminal = await socket({ origin: g.origin }, `api/v1/terminal/${project.id}?cols=60&rows=20`, { Authorization: authorization });
    await until(() => terminal.packets.some(packet => packet.mode === 'control'));
    terminal.command("printf 'EMACHINE_%s_OK\\n' GATEWAY_TEST");
    await until(() => terminal.text.includes('EMACHINE_GATEWAY_TEST_OK')); await terminal.close(); terminal = undefined;
    browser = await chromium.launch({ executablePath: execFileSync('chromiumfish', ['path'], { encoding: 'utf8' }).trim(), headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, httpCredentials: { username: 'emachine', password } });
    const page = await context.newPage();
    const requests = [], packets = [];
    page.on('request', request => requests.push(request.url()));
    page.on('websocket', ws => ws.on('framereceived', frame => packets.push(String(frame.payload))));
    assert.equal((await page.goto(publicUrl)).status(), 200);
    await page.waitForFunction(() => document.body.textContent.includes('alpha'));
    await until(() => packets.some(packet => packet.includes('inventory')));
    const connections = await page.evaluate(() => JSON.parse(localStorage.getItem('emachine:connections:v1')));
    assert.equal(connections[0].direct, publicUrl);
    assert.ok(requests.every(url => !url.startsWith(f.origin + '/')), 'The browser attempted a private upstream route.');
    await page.evaluate(() => navigator.serviceWorker.ready);
    const cached = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async name => (await (await caches.open(name)).keys()).map(request => request.url)))).flat());
    assert.ok(cached.length > 0);
    assert.ok(cached.every(url => !/bootstrap\.json|\/api\/|\/features\//.test(url)));
    await mkdir(join(root, 'test-results'), { recursive: true });
    await page.screenshot({ path: join(root, 'test-results/phone-gateway.png') });
  } finally { await close(); }
});

test('protected manifest declares document credentials', async () => {
  const html = await readFile(join(root, 'web/index.html'), 'utf8');
  const manifest = html.match(/<link\b[^>]*\brel="manifest"[^>]*>/)?.[0];
  assert.ok(manifest, 'The shell must link its manifest.');
  assert.match(manifest, /\bcrossorigin="use-credentials"/, 'The protected manifest must reuse the document credentials.');
});

test('browser manifest fetch reuses the document login', { timeout: 30000 }, async t => {
  const listenPort = await freePort(), publicUrl = `http://127.0.0.1:${listenPort}/`;
  const f = await fixture({ origins: [new URL(publicUrl).origin] });
  let browser, g, closing;
  const close = () => closing ??= (async () => { await browser?.close(); await g?.close(); await f.close(); })();
  t.after(close); t.signal.addEventListener('abort', () => { void close(); }, { once: true });
  try {
    const state = await f.state();
    g = await gateway({ publicUrl, listenPort, upstreamPort: f.port, gatewaySecret: f.config.gatewaySecret, machine: state.machine }, t);
    browser = await chromium.launch({ executablePath: execFileSync('chromiumfish', ['path'], { encoding: 'utf8' }).trim(), headless: true });
    // Cached shell bytes must not conceal an unauthenticated browser manifest request.
    const context = await browser.newContext({ serviceWorkers: 'block', httpCredentials: { username: 'emachine', password } });
    const page = await context.newPage(), devtools = await context.newCDPSession(page);
    assert.equal((await page.goto(publicUrl)).status(), 200);
    const manifest = await devtools.send('Page.getAppManifest');
    assert.deepEqual(manifest.errors, [], 'The browser could not fetch its protected manifest.');
    const expected = await (await g.request('manifest.webmanifest', { headers: { Authorization: authorization, Origin: g.origin } })).json();
    assert.deepEqual(JSON.parse(manifest.data), expected);
  } finally { await close(); }
});

test('gateway requires the complete authority including its port', { timeout: 20000 }, async t => {
  const listenPort = await freePort();
  const g = await gateway({ publicUrl: `http://127.0.0.1:${listenPort}/`, listenPort, upstreamPort: await freePort(), gatewaySecret: randomBytes(32).toString('hex'), machine: { id: 'fixture', name: 'Fixture' } }, t);
  t.after(() => g.close());
  for (const Host of ['127.0.0.1', '127.0.0.1:443', '127.0.0.1:8443']) {
    if (Host === new URL(g.origin).host) continue;
    assert.equal((await g.request('bootstrap.json', { headers: { Host, Authorization: authorization, Origin: g.origin } })).status, 421, Host);
  }
  assert.equal((await g.request('bootstrap.json', { headers: { Authorization: authorization, Origin: g.origin } })).status, 200);
});

test('socket rejection helper settles transport failures', async () => {
  await assert.rejects(Promise.race([
    rejection(`http://127.0.0.1:${await freePort()}/`, {}),
    new Promise(resolve => setTimeout(() => resolve('unsettled transport failure'), 1000)),
  ]), /ECONNREFUSED|connect/);
});

test('gateway maps only validated public origins to an existing native origin', { timeout: 30000 }, async t => {
  const f = await fixture(); t.after(() => f.close());
  const state = await f.state();
  const listenPort = await freePort(), publicUrl = `http://127.0.0.1:${listenPort}/`;
  const g = await gateway({ publicUrl, listenPort, upstreamPort: f.port, upstreamOrigin: f.origin, gatewaySecret: f.config.gatewaySecret, machine: state.machine }, t);
  t.after(() => g.close());
  const headers = { Authorization: authorization, Origin: g.origin };
  const response = await g.request('api/v1/state', { headers });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).machine.id, state.machine.id);
  assert.equal((await g.request('api/v1/state', { headers: { ...headers, Origin: f.origin } })).status, 403);
  const events = await socket({ origin: g.origin }, 'api/v1/events', { Authorization: authorization });
  t.after(() => events.close());
  await until(() => events.packets.some(packet => packet.type === 'inventory'));
  const { gatewayConfig } = await implementation();
  assert.throws(() => gatewayConfig({ publicUrl, listenPort, upstreamPort: f.port, upstreamOrigin: 'https://attacker.example', passwordHash, gatewaySecret: f.config.gatewaySecret, machine: state.machine }));
});
