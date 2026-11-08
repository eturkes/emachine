import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect } from '@playwright/test';
import { WebSocketServer } from 'ws';

const ip = '100.73.81.6', host = 'peer.desktop-test.ts.net';
const script = fileURLToPath(import.meta.url);
if (!process.argv.includes('--fixture')) {
  // Only the test network namespace owns this address. No tailnet routes or live peers are used.
  execFileSync('unshare', ['--user', '--map-current-user', '--keep-caps', '--net', 'sh', '-ec',
    'ip link set lo up; ip addr add "$1/32" dev lo; exec "$2" "$3" --fixture', 'desktop-network', ip, process.execPath, script], { stdio: 'inherit' });
  process.exit(0);
}
const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const image = resolve(process.env.EMACHINE_APPIMAGE || join(root, `desktop/release/emachine-${version}-x86_64.AppImage`));
const stage = await mkdtemp(join(tmpdir(), 'emachine-network-e2e-'));
const profile = join(stage, 'profile');
const env = { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1', HOME: stage, XDG_CONFIG_HOME: join(stage, 'config'),
  XDG_CACHE_HOME: join(stage, 'cache'), XDG_CURRENT_DESKTOP: 'generic', DESKTOP_SESSION: 'generic', KDE_FULL_SESSION: '', no_proxy: '', NO_PROXY: '' };
for (const line of execFileSync('systemctl', ['--user', 'show-environment'], { encoding: 'utf8' }).split('\n')) {
  if (/^(DISPLAY|XAUTHORITY)=/.test(line)) { const i = line.indexOf('='); env[line.slice(0, i)] = line.slice(i + 1); }
}

const listen = (server, address) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, address, () => { server.off('error', reject); resolve(server.address().port); });
});
let app, secure, sockets;
const tunnels = [];
const proxy = createHttpServer();
proxy.on('connect', (request, socket) => {
  tunnels.push(request.url);
  socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
});

try {
  const proxyAddress = '127.0.0.1:' + await listen(proxy, '127.0.0.1');
  env.http_proxy = env.https_proxy = env.all_proxy = 'http://' + proxyAddress;
  const status = { BackendState: 'Running', MagicDNSSuffix: 'desktop-test.ts.net',
    Self: { DNSName: 'self.desktop-test.ts.net.', TailscaleIPs: ['100.73.81.5'] },
    Peer: { fixture: { DNSName: host + '.', TailscaleIPs: [ip] } } };
  await mkdir(join(stage, 'bin'));
  await writeFile(join(stage, 'bin/tailscale'), `#!/bin/sh\n[ "$*" = "status --json" ] || exit 2\nprintf '%s\\n' '${JSON.stringify(status)}'\n`, { mode: 0o700 });
  env.PATH = join(stage, 'bin') + ':' + env.PATH;

  const keyFile = join(stage, 'key.pem'), certFile = join(stage, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=' + host,
    '-addext', 'subjectAltName=DNS:' + host, '-keyout', keyFile, '-out', certFile], { stdio: 'ignore' });
  const cert = await readFile(certFile);
  const spki = createHash('sha256').update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  const identity = req => ({ host: req.headers.host, sni: req.socket.servername, origin: req.headers.origin });
  secure = createHttpsServer({ key: await readFile(keyFile), cert }, (req, res) => {
    res.writeHead(200, { 'Access-Control-Allow-Origin': 'emachine://app', 'Access-Control-Allow-Credentials': 'true', 'Content-Type': 'application/json' });
    res.end(JSON.stringify(identity(req)));
  });
  sockets = new WebSocketServer({ server: secure });
  sockets.on('connection', (socket, req) => { socket.send(JSON.stringify(identity(req))); });
  const authority = host + ':' + await listen(secure, ip), url = 'https://' + authority + '/';
  const expected = { host: authority, sni: host, origin: 'emachine://app' };

  async function launch(extra = [], trustFixture = true) {
    const args = ['--user-data-dir=' + profile, ...extra];
    if (trustFixture) args.push('--ignore-certificate-errors-spki-list=' + spki);
    app = await electron.launch({ executablePath: image, args, env, timeout: 60000 });
    const page = await app.firstWindow(); await expect(page.locator('.brand-name')).toHaveText('emachine');
    return page;
  }
  const route = url => app.evaluate(({ session }, url) => session.defaultSession.resolveProxy(url), url);
  const fetchNative = url => app.evaluate(async ({ net }, url) => {
    const r = await net.fetch(url, { credentials: 'omit', headers: { Origin: 'emachine://app' }, signal: AbortSignal.timeout(5000) });
    return r.json();
  }, url);
  async function toggle(response) {
    const found = await app.evaluate(({ BrowserWindow, Menu, dialog }, response) => {
      const menu = Menu.getApplicationMenu()?.items.find(item => item.label === 'Network')?.submenu;
      const item = menu?.items.find(item => item.label === 'Direct Tailscale networking');
      if (item?.type !== 'checkbox') return false;
      dialog.showMessageBox = async () => ({ response });
      item.click({}, BrowserWindow.getAllWindows()[0], {});
      return true;
    }, response);
    assert.ok(found, 'The packaged native Network menu must offer Direct Tailscale networking.');
  }

  await launch();
  assert.equal(await route(url), 'PROXY ' + proxyAddress);
  await assert.rejects(fetchNative(url)); assert.ok(tunnels.includes(authority), 'Default traffic must contact the test proxy.');
  await toggle(0);
  await toggle(1);
  assert.equal(await route(url), 'PROXY ' + proxyAddress, 'The setting applies on the next launch.');
  await app.close();

  const page = await launch();
  assert.equal(await route(url), 'DIRECT');
  assert.equal(await route('https://unrelated.invalid/'), 'DIRECT', 'The opt-in bypasses proxies for this AppImage.');
  assert.deepEqual(await fetchNative(url), expected);
  assert.deepEqual(await page.evaluate(async url => (await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(5000) })).json(), url), expected);
  assert.deepEqual(await page.evaluate(url => new Promise((resolve, reject) => {
    const socket = new WebSocket(url.replace('https:', 'wss:'));
    const timer = setTimeout(() => { socket.close(); reject(new Error('WebSocket fixture timed out')); }, 5000);
    socket.onmessage = e => { clearTimeout(timer); socket.close(); resolve(JSON.parse(e.data)); };
    socket.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket fixture failed')); };
  }), url), expected);
  await assert.rejects(fetchNative(url.replace(host, 'unlisted.desktop-test.ts.net')), 'Unlisted names must not map to the fixture.');
  await app.close();

  await launch([], false);
  assert.equal(await route(url), 'DIRECT');
  await assert.rejects(fetchNative(url), /ERR_CERT_AUTHORITY_INVALID/);
  await app.close();

  await launch(['--proxy-server=' + env.http_proxy]);
  assert.equal(await route(url), 'PROXY ' + proxyAddress, 'Explicit proxy switches keep precedence.');
  await toggle(1);
  await app.close();
  await launch();
  assert.equal(await route(url), 'PROXY ' + proxyAddress, 'Turning the option off restores ordinary routing.');
  console.log('Packaged Tailscale networking passed: native opt-in, persisted direct HTTPS and WSS, original hostname and TLS SNI, default proxy, explicit override and opt-out.');
} finally {
  await app?.close();
  for (const client of sockets?.clients ?? []) client.terminate();
  sockets?.close(); secure?.closeAllConnections(); secure?.close(); proxy.closeAllConnections(); proxy.close();
  await rm(stage, { recursive: true, force: true });
}
