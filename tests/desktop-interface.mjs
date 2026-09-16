import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fixture, root, socket } from './network-helper.mjs';

const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const image = resolve(process.env.EMACHINE_APPIMAGE || join(root, `desktop/release/emachine-${version}-x86_64.AppImage`));
await mkdir(join(root, '.work'), { recursive: true });
const stage = await mkdtemp(join(root, '.work/interface-e2e-'));
const profile = join(stage, 'profile');
const feedRoot = join(stage, 'feed');
const env = { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' };
for (const line of execFileSync('systemctl', ['--user', 'show-environment'], { encoding: 'utf8' }).split('\n')) {
  if (/^(DISPLAY|XAUTHORITY|WAYLAND_DISPLAY)=/.test(line)) { const i = line.indexOf('='); env[line.slice(0, i)] = line.slice(i + 1); }
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function imageDigest() { const h = createHash('sha256'); for await (const chunk of createReadStream(image)) h.update(chunk); return h.digest('hex'); }
let app, server, machine, observer;
let manifest, corrupt = false, unavailable = false;
const requests = [];
async function launch() {
  app = await electron.launch({ executablePath: image, args: ['--user-data-dir=' + profile], env, timeout: 60000 });
  const page = await app.firstWindow();
  await expect(page.locator('.brand-name')).toHaveText('emachine');
  return page;
}
const state = page => page.evaluate(() => window.emachineInterface.getState());
const open = async page => { await page.getByRole('button', { name: 'Interface updates', exact: true }).click(); };
const close = async page => { await page.getByRole('button', { name: 'Close dialog', exact: true }).click(); };
try {
  let page = await launch();
  // Keep this regression before importing the new manifest builder: old AppImages fail on the missing capability.
  await expect(page.getByRole('button', { name: 'Interface updates', exact: true })).toBeVisible({ timeout: 5000 });
  const { buildInterfaceManifest } = await import('../scripts/interface-manifest.mjs');
  const before = await imageDigest();
  const originalPid = await app.evaluate(() => process.pid);
  await expect.poll(async () => (await state(page)).status).not.toBe('loading');
  const bundled = (await state(page)).revision;
  await cp(join(root, 'web/dist'), feedRoot, { recursive: true });
  const originalIndex = await readFile(join(feedRoot, 'index.html'), 'utf8');
  async function publish(marker, broken = false) {
    const html = broken ? '<!doctype html><title>Broken interface fixture</title><p id="broken-interface">No startup script</p>' :
      originalIndex.replace('</head>', `<meta name="emachine-ui-test" content="${marker}"></head>`);
    await writeFile(join(feedRoot, 'index.html'), html);
    manifest = await buildInterfaceManifest(feedRoot);
    return manifest.revision;
  }
  const a = await publish('revision-a');
  server = createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', 'emachine://app');
    const path = new URL(request.url, 'http://127.0.0.1').pathname.slice(1); requests.push(path);
    if (unavailable) { response.writeHead(503); response.end('offline fixture'); return; }
    if (path === 'ui-manifest.json') { response.end(JSON.stringify(manifest)); return; }
    if (!manifest.files.some(file => file.path === path)) { response.writeHead(404); response.end(); return; }
    try {
      const bytes = await readFile(join(feedRoot, path));
      if (corrupt && path === 'index.html') bytes[0] ^= 1;
      response.setHeader('Content-Length', bytes.length); response.end(bytes);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const source = `http://127.0.0.1:${server.address().port}/`;
  await app.evaluate(({ dialog }) => {
    globalThis.interfaceConsent = false; globalThis.interfacePrompts = [];
    const original = dialog.showMessageBox;
    dialog.showMessageBox = async (window, options) => {
      if (options.title === 'Trust interface source') {
        globalThis.interfacePrompts.push(options);
        return { response: globalThis.interfaceConsent ? 1 : 0, checkboxChecked: false };
      }
      if (options.title === 'Restore bundled interface') return { response: 1, checkboxChecked: false };
      return original(window, options);
    };
  });
  await open(page);
  await page.getByLabel('Interface source', { exact: true }).fill(source);
  await page.getByRole('button', { name: 'Use this source', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use this source', exact: true })).toBeEnabled();
  assert.equal((await state(page)).source, ''); assert.deepEqual(requests, []);
  await app.evaluate(() => { globalThis.interfaceConsent = true; });
  await page.getByRole('button', { name: 'Use this source', exact: true }).click();
  await expect.poll(async () => (await state(page)).status).toBe('available');
  assert.equal((await state(page)).revision, bundled);
  assert.ok(requests.length && requests.every(path => path === 'ui-manifest.json'));
  const prompts = await app.evaluate(() => globalThis.interfacePrompts);
  assert.equal(prompts.length, 2); assert.ok(prompts.every(prompt => prompt.detail.includes(source)));
  await close(page);
  machine = await fixture({ name: 'Interface acceptance' });
  await page.getByRole('button', { name: 'Machine settings', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Interface acceptance');
  await page.getByLabel('Direct address', { exact: true }).fill(machine.origin + '/');
  await page.getByRole('button', { name: 'Connect machine', exact: true }).click();
  await page.getByRole('button', { name: 'beta on Interface acceptance, online', exact: true }).click();
  await expect(page.locator('.terminal-pane:not([hidden])')).toHaveAttribute('data-mode', 'control');
  const beta = (await machine.state()).projects.find(project => project.name === 'beta');
  observer = await socket(machine, `api/v1/terminal/${beta.id}`);
  await page.locator('.terminal-pane:not([hidden]) .xterm-helper-textarea').focus();
  await page.keyboard.type("printf '__INTERFACE''_BEFORE__\\n'"); await page.keyboard.press('Enter');
  await expect.poll(() => observer.text.includes('__INTERFACE_BEFORE__')).toBe(true);
  // An observing test socket becomes controller when the UI disconnects; keep this a single-client refresh.
  await observer.close(); observer = undefined;
  const stored = await page.evaluate(() => {
    localStorage.setItem('emachine:interface-regression', 'retained');
    return { connections: localStorage.getItem('emachine:connections:v1'), selection: localStorage.getItem('emachine:selection') };
  });
  assert.notEqual(stored.connections, null);
  assert.equal((await state(page)).source, source, 'Selecting another machine must not change the UI source.');
  await open(page); requests.length = 0;
  await page.getByRole('button', { name: 'Refresh interface', exact: true }).click();
  await expect(page.locator('meta[name="emachine-ui-test"]')).toHaveAttribute('content', 'revision-a');
  await expect.poll(async () => (await state(page)).status).toBe('current');
  assert.equal((await state(page)).revision, a);
  assert.deepEqual(requests.filter(path => path !== 'ui-manifest.json'), ['index.html']);
  assert.equal((await state(page)).downloadedBytes, (await readFile(join(feedRoot, 'index.html'))).length);
  assert.equal(await app.evaluate(() => process.pid), originalPid);
  assert.equal(await imageDigest(), before);
  assert.equal(await page.evaluate(() => localStorage.getItem('emachine:interface-regression')), 'retained');
  assert.deepEqual(await page.evaluate(() => ({ connections: localStorage.getItem('emachine:connections:v1'), selection: localStorage.getItem('emachine:selection') })), stored);
  await expect(page.getByRole('button', { name: 'beta on Interface acceptance, online', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.terminal-pane:not([hidden])')).toHaveAttribute('data-mode', 'control');
  observer = await socket(machine, `api/v1/terminal/${beta.id}`);
  await expect.poll(() => observer.text.includes('__INTERFACE_BEFORE__')).toBe(true);
  await page.locator('.terminal-pane:not([hidden]) .xterm-helper-textarea').focus();
  await page.keyboard.type("printf '__INTERFACE''_AFTER__\\n'"); await page.keyboard.press('Enter');
  await expect.poll(() => observer.text.includes('__INTERFACE_AFTER__')).toBe(true);
  await observer.close(); observer = undefined;
  assert.deepEqual(await page.evaluate(() => ({ node: typeof process, require: typeof require, url: location.href })),
    { node: 'undefined', require: 'undefined', url: 'emachine://app/index.html' });
  const feature = JSON.parse(await machine.cli('feature', 'create', 'beta', 'ui-isolation', 'UI isolation')).workspace;
  await writeFile(join(feature, 'index.html'), '<!doctype html><p>Isolated fixture view</p>');
  await machine.cli('feature', 'activate', 'beta', 'ui-isolation');
  await page.getByRole('tab', { name: 'UI isolation', exact: true }).click();
  const frame = page.frameLocator('iframe[title="UI isolation — beta"]');
  await expect(frame.locator('p')).toHaveText('Isolated fixture view');
  assert.equal(await frame.locator('p').evaluate(() => typeof window.emachineInterface), 'undefined');
  await machine.cli('feature', 'remove', 'beta', 'ui-isolation');
  await expect(page.locator('.feature-frame')).toHaveCount(0);
  const b = await publish('revision-b'); corrupt = true;
  await open(page); await page.getByRole('button', { name: 'Refresh interface', exact: true }).click();
  await expect(page.locator('.interface-message')).toContainText('integrity check');
  assert.equal((await state(page)).revision, a); assert.equal(await app.evaluate(() => process.pid), originalPid);
  corrupt = false; manifest.bridge = 2;
  manifest.revision = hash(JSON.stringify({ format: manifest.format, bridge: manifest.bridge, files: manifest.files }));
  await page.getByRole('button', { name: 'Refresh interface', exact: true }).click();
  await expect(page.locator('.interface-message')).toContainText('runtime');
  assert.equal((await state(page)).revision, a);
  await publish('revision-b');
  await page.getByRole('button', { name: 'Refresh interface', exact: true }).click();
  await expect(page.locator('meta[name="emachine-ui-test"]')).toHaveAttribute('content', 'revision-b');
  await expect.poll(async () => (await state(page)).status).toBe('current');
  assert.equal((await state(page)).revision, b);
  await publish('broken', true); await open(page);
  await page.getByRole('button', { name: 'Refresh interface', exact: true }).click();
  await expect(page.locator('#broken-interface')).toBeVisible();
  await expect(page.locator('meta[name="emachine-ui-test"]')).toHaveAttribute('content', 'revision-b', { timeout: 25000 });
  assert.equal((await state(page)).revision, b);
  unavailable = true; await app.close(); app = undefined;
  page = await launch();
  await expect(page.locator('meta[name="emachine-ui-test"]')).toHaveAttribute('content', 'revision-b');
  assert.equal((await state(page)).revision, b);
  assert.equal(await page.evaluate(() => localStorage.getItem('emachine:interface-regression')), 'retained');
  await open(page); await page.getByRole('button', { name: 'Check interface', exact: true }).click();
  await expect.poll(async () => (await state(page)).status).toBe('error');
  assert.equal((await state(page)).revision, b);
  await mkdir(join(root, 'test-results'), { recursive: true });
  await page.screenshot({ path: join(root, 'test-results/emachine-interface-desktop.png') });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(420, 780));
  await page.screenshot({ path: join(root, 'test-results/emachine-interface-narrow.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await close(page); unavailable = false;
  await open(page); await page.getByRole('button', { name: 'Refresh interface', exact: true }).click();
  await expect(page.locator('#broken-interface')).toBeVisible();
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
  // CDP page.keyboard bypasses Electron menu accelerators; dispatch through the native window.
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.focus(); window.webContents.focus();
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'B', modifiers: ['control', 'shift'] });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'B', modifiers: ['control', 'shift'] });
  });
  await expect(page.locator('.brand-name')).toHaveText('emachine');
  await expect.poll(async () => (await state(page)).status).not.toBe('loading');
  assert.equal((await state(page)).revision, bundled);
  assert.equal(await page.locator('meta[name="emachine-ui-test"]').count(), 0);
  unavailable = true; await app.close(); app = undefined;
  page = await launch();
  assert.equal((await state(page)).revision, bundled, 'Explicit bundled recovery must survive a restart.');
  assert.equal(await imageDigest(), before);
  console.log(`Desktop UI refresh passed: native trust, selective transfer, same PID/AppImage, retained selection and live zmx, frame isolation, digest/bridge rejection, readiness rollback, offline cached startup and native bundled recovery. AppImage SHA256 ${before}.`);
} finally {
  await app?.close(); await observer?.close(); await machine?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await rm(stage, { recursive: true, force: true });
}
