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
  if (process.argv.includes('--interface')) {
    // Exercise renderer-only delivery through the existing AppImage's native-approved loader.
    await app.evaluate(({ dialog }) => {
      globalThis.clipboardTestDialog = dialog.showMessageBox;
      dialog.showMessageBox = async (window, options) => options.title === 'Trust interface source'
        ? { response: 1, checkboxChecked: false } : globalThis.clipboardTestDialog(window, options);
    });
    try {
      await page.getByRole('button', { name: 'Interface updates', exact: true }).click();
      await page.getByLabel('Interface source', { exact: true }).fill(f.origin + '/');
      await page.getByRole('button', { name: 'Use this source', exact: true }).click();
      await expect.poll(() => page.evaluate(() => window.emachineInterface.getState().then(state => state.status)))
        .toMatch(/^(available|current)$/);
      await Promise.all([
        page.waitForEvent('domcontentloaded', { timeout: 15000 }),
        page.getByRole('button', { name: 'Refresh interface', exact: true }).click(),
      ]);
      await expect.poll(() => page.evaluate(() => window.emachineInterface.getState().then(state => state.bundled))).toBe(false);
      await expect(page.locator('dialog[open]')).toHaveCount(0);
    } finally {
      await app.evaluate(({ dialog }) => { dialog.showMessageBox = globalThis.clipboardTestDialog; delete globalThis.clipboardTestDialog; });
    }
  }
  await page.getByRole('button', { name: 'Machine settings', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Desktop acceptance');
  await page.getByLabel('Direct address', { exact: true }).fill(f.origin + '/');
  await page.getByRole('button', { name: 'Connect machine', exact: true }).click();
  await expect(page.getByRole('button', { name: 'alpha on Desktop acceptance, online', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'alpha on Desktop acceptance, online', exact: true }).click();
  await expect(page.locator('.terminal-pane:not([hidden])')).toHaveAttribute('data-mode', 'control');
  const sidebar = page.locator('.project-rail');
  const workspace = page.locator('.workspace');
  const activeTerminal = page.locator('.terminal-pane:not([hidden]) .xterm');
  const terminalElement = await activeTerminal.elementHandle();
  const terminalRows = activeTerminal.locator('.xterm-rows');
  await expect.poll(async () => (await terminalRows.boundingBox())?.width ?? 0).toBeGreaterThan(0);
  const initialWorkspace = (await workspace.boundingBox()).width;
  const initialTerminal = (await terminalRows.boundingBox()).width;
  const collapseSidebar = page.getByRole('button', { name: 'Collapse project sidebar', exact: true });
  await expect(collapseSidebar).toHaveAttribute('aria-expanded', 'true');
  await collapseSidebar.click();
  const expandSidebar = page.getByRole('button', { name: 'Expand project sidebar', exact: true });
  await expect(expandSidebar).toHaveAttribute('aria-expanded', 'false');
  await expect(sidebar).toBeHidden();
  await expect.poll(async () => (await workspace.boundingBox()).width).toBeGreaterThan(initialWorkspace + 200);
  await expect.poll(async () => (await terminalRows.boundingBox()).width).toBeGreaterThan(initialTerminal + 150);
  assert.equal(await activeTerminal.evaluate((element, original) => element === original, terminalElement), true);
  await page.screenshot({ path: join(root, 'test-results/sidebar-desktop-collapsed.png') });
  await expandSidebar.click();
  await expect(sidebar).toBeVisible();
  await expect.poll(async () => (await workspace.boundingBox()).width).toBe(initialWorkspace);
  await expect.poll(async () => (await terminalRows.boundingBox()).width).toBe(initialTerminal);
  await expect(page.locator('.terminal-pane:not([hidden])')).toHaveAttribute('data-mode', 'control');
  assert.equal(await activeTerminal.evaluate((element, original) => element === original, terminalElement), true);
  console.log('Desktop sidebar passed: collapse, expand, retained terminal, and refitted columns.');
  // Keep the user's clipboard inside the native process; never expose its bytes to test output.
  await app.evaluate(async ({ clipboard, ClipboardItem }) => {
    globalThis.savedTestClipboard = await Promise.all((await clipboard.read()).map(async item =>
      new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)]))))));
  });
  try {
    await app.evaluate(({ clipboard }) => clipboard.writeText('emachineClipboardPreserve'));
    const terminal = page.locator('.terminal-pane:not([hidden])');
    const copy = terminal.getByRole('button', { name: 'Copy', exact: true });
    await copy.click();
    await expect(page.locator('.toast-region')).toContainText('Select terminal text to copy.');
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), 'emachineClipboardPreserve');
    await terminal.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type("printf '\\033[2J\\033[H%s\\n' emachineClipboardFixture");
    await page.keyboard.press('Enter');
    const text = terminal.locator('.xterm-rows span').filter({ hasText: /^emachineClipboardFixture$/ }).first();
    await expect(text).toBeVisible();
    const bounds = await text.boundingBox();
    await page.mouse.dblclick(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await copy.click();
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText()),
      { message: 'The packaged Copy button must write the selected terminal text to the system clipboard.' })
      .toBe('emachineClipboardFixture');
    await expect(terminal.locator('.xterm-helper-textarea')).toBeFocused();
    await expect(page.locator('.toast-region')).not.toContainText('Clipboard access was not granted.');
    await app.evaluate(({ clipboard }) => clipboard.writeText('shortcut sentinel'));
    await page.keyboard.press('Control+Shift+C');
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('emachineClipboardFixture');
    await app.evaluate(({ clipboard }) => clipboard.writeText('menu sentinel'));
    await terminal.locator('.terminal-host').click({ button: 'right', position: { x: 300, y: 100 } });
    const menu = page.getByRole('menu', { name: 'Terminal actions', exact: true });
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitem', { name: 'Copy', exact: true }).click();
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('emachineClipboardFixture');
    await expect(menu).toBeHidden();
    await expect(terminal.locator('.xterm-helper-textarea')).toBeFocused();
    await app.evaluate(({ clipboard }) => clipboard.writeText("printf '__CLIPBOARD''_PASTE__\\n'"));
    await terminal.getByRole('button', { name: 'Paste', exact: true }).click();
    await expect(terminal.locator('.xterm-helper-textarea')).toBeFocused();
    await expect(terminal.locator('.xterm-rows')).toContainText("printf '__CLIPBOARD''_PASTE__\\n'");
    await page.keyboard.press('Enter');
    await expect(terminal.locator('.xterm-rows')).toContainText('__CLIPBOARD_PASTE__');
    await expect(page.locator('.toast-region')).not.toContainText('Clipboard access was not granted.');
    for (const method of ['shortcut', 'menu']) {
      const marker = method === 'shortcut' ? '__SHORTCUT_PASTE__' : '__MENU_PASTE__';
      const command = `printf '%s\\n' '${marker}'`;
      await app.evaluate(({ clipboard }, command) => clipboard.writeText(command), command);
      if (method === 'shortcut') await page.keyboard.press('Control+Shift+V');
      else {
        await terminal.locator('.terminal-host').click({ button: 'right', position: { x: 300, y: 100 } });
        await menu.getByRole('menuitem', { name: 'Paste', exact: true }).click();
      }
      await expect(terminal.locator('.xterm-helper-textarea')).toBeFocused();
      await expect(terminal.locator('.xterm-rows')).toContainText(command);
      await page.keyboard.press('Enter');
      await expect(terminal.locator('.xterm-rows span').filter({ hasText: new RegExp(`^${marker}$`) }).first()).toBeVisible();
    }
    await app.evaluate(({ clipboard }) => clipboard.writeText("printf '__CLIPBOARD''_PASTE__\\n'"));
    // Grant iframe policy explicitly so the native permission boundary, not Chromium's default policy, is tested.
    await page.route(f.origin + '/clipboard-test', route => route.fulfill({ contentType: 'text/html',
      body: '<!doctype html><button>Clipboard feature fixture</button>' }));
    await page.evaluate(origin => {
      const frame = document.createElement('iframe'); frame.id = 'clipboard-feature-test';
      frame.allow = 'clipboard-read; clipboard-write'; frame.src = origin + '/clipboard-test';
      document.body.append(frame);
    }, f.origin);
    const feature = page.frameLocator('#clipboard-feature-test');
    await feature.getByRole('button', { name: 'Clipboard feature fixture' }).click();
    const denied = await feature.locator('body').evaluate(async () => {
      const result = {};
      for (const action of ['read', 'write']) {
        try {
          if (action === 'read') await navigator.clipboard.readText();
          else await navigator.clipboard.writeText('forbiddenFeatureClipboard');
          result[action] = 'allowed';
        } catch (error) { result[action] = error.name; }
      }
      return result;
    });
    assert.deepEqual(denied, { read: 'NotAllowedError', write: 'NotAllowedError' });
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), "printf '__CLIPBOARD''_PASTE__\\n'");
    await page.locator('#clipboard-feature-test').evaluate(frame => frame.remove());
    console.log('AppImage clipboard passed: empty selection preserved, real button/shortcut/menu Copy/Paste, terminal focus, feature-frame read/write denied.');
  } finally {
    await app.evaluate(async ({ clipboard }) => {
      if (globalThis.savedTestClipboard.length) await clipboard.write(globalThis.savedTestClipboard);
      else clipboard.clear();
      delete globalThis.savedTestClipboard;
    });
  }
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
