import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture, root } from './network-helper.mjs';
import { buildInterfaceManifest } from '../scripts/interface-manifest.mjs';

const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const image = resolve(process.env.EMACHINE_APPIMAGE || join(root, `desktop/release/emachine-${version}-x86_64.AppImage`));
const stage = await mkdtemp(join(tmpdir(), 'emachine-storage-e2e-'));
const desktopEnv = { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' };
for (const line of execFileSync('systemctl', ['--user', 'show-environment'], { encoding: 'utf8' }).split('\n')) {
  if (/^(DISPLAY|XAUTHORITY|WAYLAND_DISPLAY)=/.test(line)) { const i = line.indexOf('='); desktopEnv[line.slice(0, i)] = line.slice(i + 1); }
}
let app, machine;
function environment(name, cacheHome) {
  const home = join(stage, name);
  const env = { ...desktopEnv, HOME: home, XDG_CONFIG_HOME: join(home, '.config') };
  if (cacheHome === undefined) delete env.XDG_CACHE_HOME;
  else env.XDG_CACHE_HOME = cacheHome === 'custom' ? join(home, 'custom-cache') : cacheHome;
  return { env, config: join(home, '.config/emachine'),
    cache: join(cacheHome === 'custom' ? env.XDG_CACHE_HOME : join(home, '.cache'), 'emachine') };
}
async function launch(env, profile) {
  await mkdir(env.HOME, { recursive: true });
  app = await electron.launch({ executablePath: image, args: profile ? ['--user-data-dir=' + profile] : [], cwd: env.HOME, env, timeout: 60000 });
  const page = await app.firstWindow();
  await expect(page.locator('.brand-name')).toHaveText('emachine');
  return page;
}
async function close() { await app?.close(); app = undefined; }
async function paths() {
  return app.evaluate(({ app, session }) => ({ userData: app.getPath('userData'), sessionData: app.getPath('sessionData'),
    storagePath: session.defaultSession.storagePath, logs: app.getPath('logs'), crashDumps: app.getPath('crashDumps') }));
}
function expected(f) {
  return { userData: f.cache, sessionData: f.cache, storagePath: f.cache,
    logs: join(f.cache, 'logs'), crashDumps: join(f.cache, 'Crashpad') };
}
const stored = page => page.evaluate(() => Object.fromEntries(
  ['emachine:connections:v1', 'emachine:selection', 'emachine:storage-regression'].map(key => [key, localStorage.getItem(key)])));

try {
  const f = environment('migration');
  machine = await fixture({ name: 'Storage acceptance' });
  // An explicit profile preserves the old layout, including on the new AppImage.
  let page = await launch(f.env, f.config);
  assert.equal((await paths()).sessionData, f.config);
  await page.getByRole('button', { name: 'Machine settings', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Storage acceptance');
  await page.getByLabel('Direct address', { exact: true }).fill(machine.origin + '/');
  await page.getByRole('button', { name: 'Connect machine', exact: true }).click();
  await page.getByRole('button', { name: 'beta on Storage acceptance, online', exact: true }).click();
  await expect(page.locator('.terminal-pane:not([hidden])')).toHaveAttribute('data-mode', 'control');
  await page.evaluate(async () => {
    localStorage.setItem('emachine:storage-regression', 'retained');
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('storage-regression', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('records');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('records', 'readwrite');
        tx.objectStore('records').put('retained-database', 'key');
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
  });
  const original = await stored(page);
  assert.notEqual(original['emachine:connections:v1'], null);
  assert.notEqual(original['emachine:selection'], null);
  await app.evaluate(async ({ session }) => {
    await session.defaultSession.cookies.set({ url: 'https://storage.example.invalid', name: 'storage-regression',
      value: 'retained-cookie', expirationDate: Math.floor(Date.now() / 1000) + 3600, secure: true });
    await session.defaultSession.cookies.flushStore();
    session.defaultSession.flushStorageData();
  });
  execFileSync(image, [], { cwd: f.env.HOME, env: f.env, timeout: 15000, stdio: 'pipe' });
  assert.equal((await paths()).sessionData, f.config, 'An active legacy profile must keep ownership during a second launch.');
  await assert.rejects(readdir(f.cache), { code: 'ENOENT' });
  await close();
  await writeFile(join(f.config, 'config.json'), '{"server":"unchanged"}\n');
  await writeFile(join(f.config, 'unknown.json'), 'leave unknown configuration alone\n');
  await mkdir(join(f.config, 'phone')); await writeFile(join(f.config, 'phone/fixture'), 'unchanged');
  const release = join(stage, 'saved-interface');
  await cp(join(root, 'web/dist'), release, { recursive: true });
  const index = await readFile(join(release, 'index.html'), 'utf8');
  await writeFile(join(release, 'index.html'), index.replace('</head>', '<meta name="storage-migration" content="retained"></head>'));
  const manifest = await buildInterfaceManifest(release);
  await mkdir(join(f.config, 'interface/releases'), { recursive: true });
  await rename(release, join(f.config, 'interface/releases', manifest.revision));
  await writeFile(join(f.config, 'interface/state.json'), JSON.stringify({ source: '', good: manifest.revision, previous: null }));

  page = await launch(f.env);
  assert.deepEqual(await paths(), expected(f), 'Default AppImage browser storage must use ~/.cache, not ~/.config.');
  await expect(page.locator('meta[name="storage-migration"]')).toHaveAttribute('content', 'retained');
  assert.deepEqual(await stored(page), original);
  await expect(page.getByRole('button', { name: 'beta on Storage acceptance, online', exact: true })).toHaveAttribute('aria-current', 'page');
  assert.equal(await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('storage-regression', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('records');
      const record = tx.objectStore('records').get('key');
      record.onsuccess = () => resolve(record.result); record.onerror = () => reject(record.error);
      tx.oncomplete = () => db.close();
    };
  })), 'retained-database');
  assert.equal(await app.evaluate(async ({ session }) =>
    (await session.defaultSession.cookies.get({ name: 'storage-regression' }))[0]?.value), 'retained-cookie');
  const pid = await app.evaluate(() => process.pid);
  execFileSync(image, [], { cwd: f.env.HOME, env: f.env, timeout: 15000, stdio: 'pipe' });
  execFileSync(image, ['--user-data-dir=' + f.cache], { cwd: f.env.HOME, env: f.env, timeout: 15000, stdio: 'pipe' });
  assert.equal(await app.evaluate(() => process.pid), pid, 'Normal and explicit launches must share the migrated profile lock.');
  await page.evaluate(() => localStorage.setItem('emachine:storage-regression', 'updated'));
  await close();
  const allowed = new Set(['.desktop-cache-v1', 'config.json', 'unknown.json', 'phone']);
  assert.deepEqual((await readdir(f.config)).filter(name => !allowed.has(name)), [], 'Chromium runtime files must not remain in configuration.');
  assert.equal(await readFile(join(f.config, 'config.json'), 'utf8'), '{"server":"unchanged"}\n');
  assert.equal(await readFile(join(f.config, 'phone/fixture'), 'utf8'), 'unchanged');
  const entries = await readdir(f.cache);
  for (const name of ['Local Storage', 'IndexedDB', 'Cookies', 'interface']) assert.ok(entries.includes(name), `${name} must be in the cache directory.`);
  page = await launch(f.env);
  assert.deepEqual(await paths(), expected(f));
  assert.equal(await page.evaluate(() => localStorage.getItem('emachine:storage-regression')), 'updated');
  await expect(page.locator('meta[name="storage-migration"]')).toHaveAttribute('content', 'retained');
  await close();

  for (const cacheHome of [undefined, 'custom', '', 'relative/cache']) {
    const fresh = environment(cacheHome === undefined ? 'default' : cacheHome || 'empty', cacheHome);
    await launch(fresh.env);
    assert.deepEqual(await paths(), expected(fresh));
    await close();
    assert.deepEqual((await readdir(fresh.config)).filter(name => name !== '.desktop-cache-v1'), []);
  }
  console.log('AppImage storage passed: default/custom/empty/relative XDG cache paths, explicit profiles, real Local Storage/IndexedDB/cookie migration, saved connections/selection/interface, legacy/migrated singleton ownership, restart persistence, and unchanged server configuration.');
} finally {
  await close(); await machine?.close(); await rm(stage, { recursive: true, force: true });
}
