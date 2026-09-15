import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { buildInterfaceManifest } from '../scripts/interface-manifest.mjs';
import { validateManifest, sourceUrl } from '../desktop/interface-manifest.cjs';
import { createInterfaceController, registerInterfaceIpc } from '../desktop/interface.cjs';

const hash = data => createHash('sha256').update(data).digest('hex');
const revision = m => hash(JSON.stringify({ format: m.format, bridge: m.bridge, files: m.files }));
async function setup(t, options = {}, factory = createInterfaceController) {
  const home = await mkdtemp(join(tmpdir(), 'emachine-interface-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bundleRoot = join(home, 'bundle'); const cacheRoot = join(home, 'cache');
  await mkdir(join(bundleRoot, 'assets'), { recursive: true });
  await writeFile(join(bundleRoot, 'index.html'), '<!doctype html><p>Bundled interface</p>');
  await writeFile(join(bundleRoot, 'assets/font.woff2'), 'unchanged font');
  await writeFile(join(bundleRoot, 'bootstrap.json'), '{"private":"fixture identity"}');
  await writeFile(join(bundleRoot, 'sw.js'), '// browser cache');
  const bundled = await buildInterfaceManifest(bundleRoot);
  const files = new Map([
    ['index.html', Buffer.from('<!doctype html><p>Refreshed interface</p>')],
    ['assets/font.woff2', Buffer.from('unchanged font')],
  ]);
  const manifest = { format: 1, bridge: 1, files: [...files].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) })).sort((a, b) => a.path < b.path ? -1 : 1) };
  manifest.revision = revision(manifest);
  let online = true; let corrupt = false; let approve = true; let loads = 0;
  const requests = []; const approvals = [];
  const fetcher = async (url, init) => {
    requests.push(String(url));
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    assert.equal(new URL(url).origin, 'https://source.invalid');
    assert.ok(new URL(url).pathname.startsWith('/machine/'));
    if (!online) throw new Error('network failure containing private details');
    const path = new URL(url).pathname.slice('/machine/'.length);
    const bytes = path === 'ui-manifest.json' ? JSON.stringify(manifest) : corrupt ? 'damaged' : files.get(path);
    return new Response(bytes ?? 'missing', { status: bytes ? 200 : 404 });
  };
  const create = () => factory({ bundleRoot, cacheRoot, fetch: fetcher,
    confirmSource: async source => { approvals.push(source); return approve; },
    reload: async () => { loads++; }, readyTimeoutMs: 50, ...options });
  const c = await create();
  t.after(() => c.dispose());
  return { c, create, bundleRoot, cacheRoot, bundled, manifest, files, requests, approvals,
    get loads() { return loads; }, set online(value) { online = value; }, set corrupt(value) { corrupt = value; }, set approve(value) { approve = value; } };
}

test('UI manifests exclude seeds, workers and unlisted files; revisions bind exact assets', async t => {
  const f = await setup(t);
  assert.deepEqual(f.bundled.files.map(file => file.path), ['assets/font.woff2', 'index.html']);
  assert.equal(f.bundled.revision, revision(f.bundled));
  assert.equal(validateManifest(f.bundled).revision, f.bundled.revision);
  for (const mutate of [m => { m.files[0].path = '../escape'; }, m => { m.files[0].path = 'assets/%2e%2e/x.js'; },
    m => { m.files[0].path = 'https://other.invalid/x.js'; }, m => { m.files[0].path = 'bootstrap.json'; },
    m => { m.files[0].path = 'sw.js'; }, m => { m.files.push(m.files[0]); }, m => { m.files = []; },
    m => { m.files[0].bytes = 99 * 1024 * 1024; }, m => { m.files[0].bytes = -1; },
    m => { m.files[0].sha256 = 'bad'; }, m => { m.revision = '0'.repeat(64); }, m => { m.bridge = 2; }]) {
    const invalid = structuredClone(f.bundled); mutate(invalid); assert.throws(() => validateManifest(invalid));
  }
});

test('trusted source URLs allow HTTPS and loopback only, preserve prefixes, exclude secrets and ambiguous paths', () => {
  assert.equal(sourceUrl('https://machine.invalid/m/workstation').href, 'https://machine.invalid/m/workstation/');
  assert.equal(sourceUrl('http://127.0.0.1:1234/').href, 'http://127.0.0.1:1234/');
  for (const value of ['http://remote.invalid/', 'file:///tmp/ui/', 'javascript:alert(1)', 'https://user:secret@host/',
    'https://host/?secret=x', 'https://host/#x', 'https://host/a/../', 'https://host/%2e%2e/', 'https://host/a%2fb/',
    'https://host/\\escape', '\nhttps://host/', 'http://127.0.0.2/', 'http://2130706433/']) assert.throws(() => sourceUrl(value), value);
});

test('source approval is explicit; checks fetch metadata only and never reload', async t => {
  const f = await setup(t); f.approve = false;
  await f.c.setSource('https://source.invalid/machine/');
  assert.equal(f.c.getState().source, ''); assert.deepEqual(f.requests, []);
  f.approve = true; await f.c.setSource('https://source.invalid/machine/'); await f.c.check();
  assert.equal(f.c.getState().status, 'available'); assert.equal(f.loads, 0);
  assert.ok(f.requests.every(url => url.endsWith('/ui-manifest.json')));
  assert.equal(f.c.getState().revision, f.bundled.revision);
  assert.equal(f.approvals.length, 2);
});

test('refresh transfers changed files only; readiness commits cached UI and offline startup restores it', async t => {
  const f = await setup(t);
  await f.c.setSource('https://source.invalid/machine/'); await f.c.refresh();
  assert.equal(f.c.getState().status, 'loading'); assert.equal(f.loads, 1);
  assert.ok(!f.requests.some(url => url.endsWith('.woff2')));
  assert.ok(!f.requests.some(url => url.endsWith('bootstrap.json')));
  assert.equal(await readFile(f.c.assetPath('index.html'), 'utf8'), f.files.get('index.html').toString());
  assert.equal(f.c.assetPath('bootstrap.json'), join(f.bundleRoot, 'bootstrap.json'));
  assert.equal(f.c.assetPath('../escape'), null);
  await f.c.ready('stale document token'); assert.equal(f.c.getState().status, 'loading');
  await f.c.ready(f.c.documentToken()); assert.equal(f.c.getState().status, 'current');
  f.online = false;
  const reopened = await f.create(); t.after(() => reopened.dispose());
  assert.equal(reopened.getState().revision, f.manifest.revision);
  await reopened.check(); assert.equal(reopened.getState().status, 'error');
  assert.doesNotMatch(reopened.getState().message, /private details/);
  assert.equal(reopened.getState().revision, f.manifest.revision);
});

test('failed or incompatible downloads leave the current interface untouched and retry safely', async t => {
  const f = await setup(t); await f.c.setSource('https://source.invalid/machine/');
  f.corrupt = true; await f.c.refresh();
  assert.equal(f.c.getState().status, 'error'); assert.equal(f.loads, 0);
  assert.equal(f.c.getState().revision, f.bundled.revision);
  assert.ok(!(await readdir(f.cacheRoot)).some(name => name.startsWith('.stage-')));
  f.corrupt = false; f.manifest.bridge = 2; f.manifest.revision = revision(f.manifest);
  await f.c.refresh(); assert.equal(f.c.getState().status, 'error'); assert.equal(f.loads, 0);
  assert.match(f.c.getState().message, /runtime/i);
  f.manifest.bridge = 1; f.manifest.revision = revision(f.manifest);
  await f.c.refresh(); await f.c.ready(f.c.documentToken());
  assert.equal(f.c.getState().revision, f.manifest.revision);
});

test('a UI that does not report readiness rolls back; interrupted activation never replaces the startup pointer', async t => {
  const f = await setup(t); await f.c.setSource('https://source.invalid/machine/');
  await f.c.refresh(); const stale = f.c.documentToken();
  const interrupted = await f.create(); t.after(() => interrupted.dispose());
  assert.equal(interrupted.getState().revision, f.bundled.revision);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(f.c.getState().revision, f.bundled.revision); assert.equal(f.loads, 2);
  await f.c.ready(stale); assert.equal(f.c.getState().revision, f.bundled.revision);
});

test('only the application main frame can access interface control IPC', async () => {
  const handlers = new Map(); const contents = { mainFrame: { url: 'emachine://app/index.html' } };
  const names = ['getState', 'setSource', 'check', 'refresh', 'restore', 'ready', 'documentToken'];
  const c = Object.fromEntries(names.map(name => [name, () => name]));
  registerInterfaceIpc({ handle: (name, fn) => handlers.set(name, fn) }, { webContents: contents }, c);
  assert.equal(handlers.size, names.length);
  for (const handler of handlers.values()) {
    assert.ok(await handler({ sender: contents, senderFrame: contents.mainFrame }));
    for (const event of [{ sender: {}, senderFrame: contents.mainFrame }, { sender: contents, senderFrame: null },
      { sender: contents, senderFrame: { url: contents.mainFrame.url } }]) assert.throws(() => handler(event), /access denied/i);
    contents.mainFrame.url = 'https://other.invalid/';
    assert.throws(() => handler({ sender: contents, senderFrame: contents.mainFrame }), /access denied/i);
    contents.mainFrame.url = 'emachine://app/index.html';
  }
});

async function withFilesystem(overrides) {
  const file = new URL('../desktop/interface.cjs', import.meta.url);
  const localRequire = createRequire(file); const module = { exports: {} };
  const load = runInNewContext(`(function(require, module, exports) {${await readFile(file, 'utf8')}\n})`,
    { Buffer, URL, AbortSignal, setTimeout, clearTimeout });
  load(name => name === 'node:fs/promises' ? { ...fs, ...overrides } : localRequire(name), module, module.exports);
  return module.exports.createInterfaceController;
}
function gate() {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  return { entered, release, async pause() { enter(); await waiting; } };
}

test('failure during a readiness pointer write cannot promote the failed revision on restart', async t => {
  const pause = gate(); let armed = false;
  const factory = await withFilesystem({ rename: async (from, to) => {
    if (armed && to.endsWith('/state.json')) { armed = false; await pause.pause(); }
    return fs.rename(from, to);
  } });
  const f = await setup(t, {}, factory); await f.c.setSource('https://source.invalid/machine/'); await f.c.refresh();
  armed = true;
  const ready = f.c.ready(f.c.documentToken()); await pause.entered;
  const failed = f.c.loadFailed(); pause.release(); await Promise.all([ready, failed]);
  const restarted = await f.create(); t.after(() => restarted.dispose());
  assert.equal(restarted.getState().revision, f.bundled.revision);
  assert.equal(f.c.getState().revision, f.bundled.revision);
});

test('readiness cleanup excludes new refresh work until it finishes', async t => {
  const pause = gate(); let armed = false;
  const factory = await withFilesystem({ readdir: async (path, options) => {
    if (armed && path.endsWith('/releases')) { armed = false; await pause.pause(); }
    return fs.readdir(path, options);
  } });
  const f = await setup(t, {}, factory); await f.c.setSource('https://source.invalid/machine/'); await f.c.refresh();
  armed = true;
  const ready = f.c.ready(f.c.documentToken()); await pause.entered;
  f.files.set('assets/new.css', Buffer.from('body { font-weight: bold }'));
  f.manifest.files = [...f.files].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) })).sort((a, b) => a.path < b.path ? -1 : 1);
  f.manifest.revision = revision(f.manifest);
  await f.c.refresh(); const loadsDuringCleanup = f.loads;
  pause.release(); await ready;
  assert.equal(loadsDuringCleanup, 1, 'A second activation must wait for cleanup.');
  await f.c.refresh(); await f.c.ready(f.c.documentToken());
  assert.equal(await readFile(f.c.assetPath('assets/new.css'), 'utf8'), f.files.get('assets/new.css').toString());
});

test('an unavailable cache cannot prevent the verified bundled interface from opening', async t => {
  const factory = await withFilesystem({ mkdir: async (path, options) => {
    if (path.includes('/cache')) throw Object.assign(new Error('cache fixture permission'), { code: 'EACCES' });
    return fs.mkdir(path, options);
  } });
  const f = await setup(t, {}, factory);
  await f.c.start(); await f.c.ready(f.c.documentToken());
  assert.equal(f.c.getState().revision, f.bundled.revision);
  await f.c.setSource('https://source.invalid/machine/');
  assert.equal(f.c.getState().status, 'error'); assert.deepEqual(f.requests, []);
});

test('explicit bundled recovery remains selected after restarting offline', async t => {
  const f = await setup(t); await f.c.setSource('https://source.invalid/machine/'); await f.c.refresh();
  await f.c.ready(f.c.documentToken()); await f.c.restore(); await f.c.ready(f.c.documentToken());
  f.online = false;
  const restarted = await f.create(); t.after(() => restarted.dispose());
  assert.equal(restarted.getState().revision, f.bundled.revision);
});
