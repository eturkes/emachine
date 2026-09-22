import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { fixture, root } from './network-helper.mjs';
import { neutralTheme } from './theme-contract.mjs';

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
  // Read the running artifact, not the build tree: interface refresh cannot replace native launcher icons.
  const branding = await app.evaluate(({ app }) => {
    const { readFileSync } = process.getBuiltinModule('fs');
    const { dirname, join } = process.getBuiltinModule('path');
    const icons = Object.fromEntries([180, 192, 512].map(size => [size,
      readFileSync(join(app.getAppPath(), `web/dist/icons/${size}.png`)).toString('base64')]));
    return { icons, launcher: readFileSync(join(dirname(app.getPath('exe')), '.DirIcon')).toString('base64') };
  });
  for (const size of [180, 192, 512]) {
    assert.deepEqual(Buffer.from(branding.icons[size], 'base64'), await readFile(join(root, `web/public/icons/${size}.png`)),
      `Packaged ${size}px icon must match the PWA source.`);
  }
  const pixels = bytes => sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pwa = await pixels(Buffer.from(branding.icons[512], 'base64'));
  const launcher = await pixels(Buffer.from(branding.launcher, 'base64'));
  assert.deepEqual(launcher.info, pwa.info, 'AppImage launcher dimensions must match the PWA icon.');
  assert.deepEqual(launcher.data, pwa.data, 'AppImage launcher pixels must match the PWA icon.');
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
  for (const theme of ['light', 'dark']) {
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: /^Theme:/ }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await neutralTheme(page.locator('body'), {
      tokens: ['bg', 'surface', 'raised', 'hover', 'text', 'muted', 'border', 'accent', 'accent-soft', 'selection', 'backdrop', 'scrim'],
      selectors: ['.project-item.active', '.tab.active', '.header-actions', '.terminal-keys button', '.xterm-rows', '.xterm-scrollable-element'],
      surfaces: ['bg', 'surface', 'raised', 'hover'], semantic: ['warning', 'danger'],
    });
    await page.screenshot({ path: join(root, `test-results/emachine-appimage-${theme}.png`) });
  }
  await page.screenshot({ path: join(root, 'test-results/emachine-appimage.png') });
  console.log('AppImage passed: PWA-matched packaged/launcher icons, neutral light/dark themes, isolated renderer, real machine connection and zmx terminal.');
} finally {
  await app?.close(); await f.close(); await rm(profile, { recursive: true, force: true });
}
