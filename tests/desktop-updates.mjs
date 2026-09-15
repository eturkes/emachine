import assert from 'node:assert/strict';
import { _electron as electron, chromium, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { validateUpdateMetadata } from '../scripts/update-metadata.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const exec = promisify(execFile);
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const nextVersion = version.replace(/\d+$/, value => String(Number(value) + 1));
const source = resolve(process.env.EMACHINE_APPIMAGE || join(root, `desktop/release/emachine-${version}-x86_64.AppImage`));
await mkdir(join(root, '.work'), { recursive: true });
const stage = await mkdtemp(join(root, '.work/update-e2e-'));
const image = join(stage, 'emachine.AppImage');
const profile = join(stage, 'config/emachine');
const output = join(stage, 'candidate');
const artifactName = `emachine-${nextVersion}-x86_64.AppImage`;
const artifact = join(output, artifactName);
const env = { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1', XDG_CONFIG_HOME: join(stage, 'config'), XDG_CACHE_HOME: join(stage, 'cache') };
for (const line of execFileSync('systemctl', ['--user', 'show-environment'], { encoding: 'utf8' }).split('\n')) {
  if (/^(DISPLAY|XAUTHORITY|WAYLAND_DISPLAY)=/.test(line)) { const i = line.indexOf('='); env[line.slice(0, i)] = line.slice(i + 1); }
}
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
let app, restarted, server, debugPort;
let mode = 'missing'; let corrupt = true; let requests = 0;
try {
  await exec('pnpm', ['exec', 'electron-builder', '--linux', 'AppImage', '--x64', '--publish', 'never',
    `--config.extraMetadata.version=${nextVersion}`, `--config.directories.output=${output}`], { cwd: root, timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
  const metadata = await validateUpdateMetadata(output, nextVersion, artifactName);
  const artifactSize = (await stat(artifact)).size;
  await copyFile(source, image);
  const before = await digest(image);
  const after = await digest(artifact);
  assert.notEqual(before, after);
  server = createServer((request, response) => {
    requests++;
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    if (path === '/latest-linux.yml' && mode !== 'missing') {
      response.setHeader('Content-Type', 'application/yaml');
      response.end(JSON.stringify(mode === 'current' ? { ...metadata, version } : metadata));
    } else if (path === '/' + artifactName) {
      response.setHeader('Content-Length', artifactSize);
      let first = true;
      const damage = new Transform({ transform(chunk, _encoding, callback) {
        if (first && corrupt) { chunk = Buffer.from(chunk); chunk[100] ^= 1; }
        first = false; callback(null, chunk);
      } });
      const stream = createReadStream(artifact);
      response.on('close', () => { stream.destroy(); damage.destroy(); });
      stream.pipe(damage).pipe(response);
    } else { response.writeHead(404); response.end('No update metadata'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const feed = `http://127.0.0.1:${server.address().port}/`;
  const reservation = createTcpServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  debugPort = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  async function launch() {
    app = await electron.launch({ executablePath: image, args: ['--user-data-dir=' + profile], env, timeout: 60000 });
    // Test-only main-process control: production exposes no feed override or generic IPC.
    await app.evaluate(({ app }, { feed, profile, debugPort }) => {
      const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
      const updater = require('electron-updater').autoUpdater;
      updater.setFeedURL({ provider: 'generic', url: feed });
      updater.disableDifferentialDownload = true;
      const spawn = updater.spawnLog.bind(updater);
      updater.spawnLog = (file, args, environment) => spawn(file, [...args, '--user-data-dir=' + profile,
        '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + debugPort], environment);
    }, { feed, profile, debugPort });
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'App updates', exact: true }).click();
    return page;
  }
  let page = await launch();
  await expect(page.locator('.update-version')).toHaveText(`Installed version: ${version}`);
  assert.equal(requests, 0, 'Opening update controls must not contact the feed.');
  await page.evaluate(() => localStorage.setItem('emachine:update-test', 'retained'));
  const check = () => page.getByRole('button', { name: 'Check for updates', exact: true }).click();
  await check();
  await expect(page.locator('.update-message')).toContainText('no update information');
  mode = 'current'; await check();
  await expect(page.locator('.update-message')).toContainText('latest published version');
  mode = 'upgrade'; await check();
  await page.getByRole('button', { name: 'Download update', exact: true }).click();
  await expect(page.locator('.update-message')).toContainText('integrity check', { timeout: 60000 });
  assert.equal(await digest(image), before, 'A corrupt download must leave the original AppImage unchanged.');
  corrupt = false; await check();
  await page.getByRole('button', { name: 'Download update', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Restart and install', exact: true })).toBeEnabled({ timeout: 60000 });
  await app.close(); app = undefined;
  assert.equal(await digest(image), before, 'Closing the app must not install a pending update.');
  page = await launch();
  await check();
  await page.getByRole('button', { name: 'Download update', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Restart and install', exact: true })).toBeEnabled({ timeout: 60000 });
  await page.getByRole('button', { name: 'Restart and install', exact: true }).click();
  const debugUrl = `http://127.0.0.1:${debugPort}`;
  await expect.poll(async () => {
    try { return (await fetch(debugUrl + '/json/version', { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  }, { timeout: 60000 }).toBe(true);
  restarted = await chromium.connectOverCDP(debugUrl);
  const nextPage = restarted.contexts()[0].pages()[0];
  await nextPage.getByRole('button', { name: 'App updates', exact: true }).click();
  await expect(nextPage.locator('.update-version')).toHaveText(`Installed version: ${nextVersion}`);
  assert.equal(await nextPage.evaluate(() => localStorage.getItem('emachine:update-test')), 'retained');
  assert.equal(await digest(image), after, 'The stable launcher path must contain the exact new artifact.');
  console.log(`AppImage update passed: ${version} -> ${nextVersion}; missing/current feeds, corrupt download rejection, no install on quit, verified replacement, actual restart, stable path and retained profile.`);
} finally {
  try {
    const browser = restarted || await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, { timeout: 1000 });
    const session = await browser.newBrowserCDPSession();
    await session.send('Browser.close'); await browser.close();
  } catch { /* No restarted test client remains connected. */ }
  await app?.close().catch(() => {});
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await rm(stage, { recursive: true, force: true });
}
