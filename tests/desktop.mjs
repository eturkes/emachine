import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture, root } from './network-helper.mjs';

const f = await fixture({ name: 'Desktop acceptance' });
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const profile = await mkdtemp(join(tmpdir(), 'emachine-desktop-test-'));
const env = { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' };
for (const line of execFileSync('systemctl', ['--user', 'show-environment'], { encoding: 'utf8' }).split('\n')) {
  if (/^(DISPLAY|XAUTHORITY|WAYLAND_DISPLAY)=/.test(line)) { const i = line.indexOf('='); env[line.slice(0, i)] = line.slice(i + 1); }
}
let app;
try {
  app = await electron.launch({ executablePath: resolve(process.env.EMACHINE_APPIMAGE || join(root, `desktop/release/emachine-${version}-x86_64.AppImage`)), args: ['--user-data-dir=' + profile], env, timeout: 60000 });
  const page = await app.firstWindow();
  await expect(page.locator('.brand-name')).toHaveText('emachine');
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
  const isolation = await page.evaluate(() => ({ node: typeof process, require: typeof require, url: location.href }));
  assert.equal(isolation.node, 'undefined'); assert.equal(isolation.require, 'undefined');
  assert.equal(isolation.url, 'emachine://app/index.html');
  assert.equal(await page.evaluate(() => typeof window.emachineUpdates), 'undefined');
  await expect(page.getByRole('button', { name: 'App updates', exact: true, includeHidden: true })).toHaveCount(0);
  assert.equal(await app.evaluate(({ app }) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
    try { require.resolve('electron-updater'); return true; }
    catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; return false; }
  }), false, 'The packaged application must not contain the retired updater dependency.');
  if (process.argv.includes('--unseeded')) {
    const seed = await page.evaluate(async () => (await fetch(new URL('./bootstrap.json', location.href))).json());
    assert.deepEqual(seed, { servers: [] }, 'Release assets must not contain private machine connections.');
    await expect(page.locator('.empty-state')).toBeVisible();
    await expect(page.locator('.project-item')).toHaveCount(0);
  }
  if (process.argv.includes('--configured')) {
    const seed = JSON.parse(await readFile(join(root, 'web/dist/bootstrap.json'), 'utf8'));
    assert.ok(seed.servers?.length, 'Configured acceptance requires a seeded machine.');
    const response = await fetch(new URL('api/v1/state', seed.servers[0].direct), { signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.ok(state.projects.length, 'Configured terminal acceptance requires an existing project.');
    const project = state.projects[0];
    await expect(page.getByRole('button', { name: `${project.name} on ${state.machine.name}, online`, exact: true })).toBeVisible();
    await expect(page.locator('.terminal-pane:not([hidden])')).toHaveAttribute('data-mode', /^(control|observe)$/);
    console.log('Configured AppImage passed: seeded Tailscale machine and existing project terminal; no shell commands sent.');
  }
  await page.getByRole('button', { name: 'Machine settings', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Desktop acceptance');
  await page.getByLabel('Direct address', { exact: true }).fill(f.origin + '/');
  await page.getByRole('button', { name: 'Connect machine', exact: true }).click();
  await expect(page.getByRole('button', { name: 'alpha on Desktop acceptance, online', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'alpha on Desktop acceptance, online', exact: true }).click();
  await expect(page.locator('.terminal-pane:not([hidden])')).toHaveAttribute('data-mode', 'control');
  await mkdir(join(root, 'test-results'), { recursive: true });
  await page.screenshot({ path: join(root, 'test-results/emachine-appimage.png') });
  console.log('AppImage passed: packaged shell, isolated renderer, real machine connection and zmx terminal.');
} finally {
  await app?.close(); await f.close(); await rm(profile, { recursive: true, force: true });
}
