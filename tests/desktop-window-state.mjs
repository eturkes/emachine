import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const image = resolve(process.env.EMACHINE_APPIMAGE || join(root, 'desktop/release/emachine-' + version + '-x86_64.AppImage'));
const stage = await mkdtemp(join(tmpdir(), 'emachine-window-e2e-'));
const profile = join(stage, 'profile');
const env = { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1', HOME: join(stage, 'home'),
  XDG_CONFIG_HOME: join(stage, 'config'), XDG_CACHE_HOME: join(stage, 'cache') };
for (const line of execFileSync('systemctl', ['--user', 'show-environment'], { encoding: 'utf8' }).split('\n')) {
  if (/^(DISPLAY|XAUTHORITY|XDG_SESSION_TYPE|XDG_CURRENT_DESKTOP)=/.test(line)) {
    const i = line.indexOf('='); env[line.slice(0, i)] = line.slice(i + 1);
  }
}
await mkdir(env.HOME, { recursive: true });
let app;
async function launch() {
  app = await electron.launch({ executablePath: image, args: ['--user-data-dir=' + profile], env, timeout: 60000 });
  const page = await app.firstWindow();
  await expect(page.locator('.brand-name')).toHaveText('emachine');
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
  await expect.poll(() => state().then(value => value.visible)).toBe(true);
  let previous, stable = 0;
  await expect.poll(async () => {
    const current = JSON.stringify(await state());
    stable = current === previous ? stable + 1 : 0; previous = current;
    return stable;
  }, { intervals: [100] }).toBe(3);
}
async function close() { await app?.close(); app = undefined; }
async function state() {
  return app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const { width, height } = window.getNormalBounds();
    return { width, height, maximized: window.isMaximized(), minimized: window.isMinimized(),
      fullscreen: window.isFullScreen(), visible: window.isVisible() };
  });
}
async function resized(size) {
  await app.evaluate(({ BrowserWindow, screen }, size) => {
    const area = screen.getPrimaryDisplay().workArea;
    BrowserWindow.getAllWindows()[0].setBounds({ ...size,
      x: area.x + Math.floor((area.width - size.width) / 2),
      y: area.y + Math.floor((area.height - size.height) / 2) });
  }, size);
  await restored(size, false);
  return size;
}
async function maximized(value) {
  await app.evaluate(({ BrowserWindow }, value) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (value) window.maximize(); else window.unmaximize();
  }, value);
  await expect.poll(() => state().then(state => state.maximized)).toBe(value);
}
async function restored(size, wasMaximized) {
  if (wasMaximized) {
    await expect.poll(state).toMatchObject({ maximized: true, minimized: false, fullscreen: false, visible: true });
    // X11 can report maximized bounds from getNormalBounds. Verify the actual
    // restore target by unmaximizing, then return to the requested mode.
    await maximized(false); await restored(size, false); await maximized(true);
  } else {
    await expect.poll(state).toEqual({ ...size, maximized: false, minimized: false, fullscreen: false, visible: true });
  }
}

try {
  await launch();
  const workArea = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workAreaSize);
  // Use representable pixel-grid dimensions for exact restoration assertions.
  // An arbitrary fractional-DPI size has its own no-growth regression below.
  const requested = { width: Math.max(Math.min(420, workArea.width), Math.min(1000, Math.floor(workArea.width * 0.7 / 8) * 8)),
    height: Math.max(Math.min(380, workArea.height), Math.min(696, Math.floor(workArea.height * 0.7 / 8) * 8)) };
  // Clear a window manager's automatic vertical maximization on small displays.
  await maximized(true); await maximized(false);
  const size = await resized(requested); await close();
  await launch(); await restored(size, false);
  console.log('AppImage restored resized normal window: ' + JSON.stringify(size));

  await maximized(true); await close();
  await launch(); await restored(size, true);
  await maximized(false); await restored(size, false);
  const changed = await resized({ width: Math.max(Math.min(420, workArea.width), size.width - 80),
    height: Math.max(Math.min(380, workArea.height), size.height - 56) });
  await close();
  await launch(); await restored(changed, false);

  for (const wasMaximized of [false, true]) {
    await maximized(wasMaximized);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
    await expect.poll(() => state().then(value => value.minimized)).toBe(true);
    await close(); await launch(); await restored(changed, wasMaximized);
  }
  for (const wasMaximized of [false, true]) {
    await maximized(wasMaximized);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(true));
    await expect.poll(() => state().then(value => value.fullscreen)).toBe(true);
    await close(); await launch(); await restored(changed, wasMaximized);
  }

  await close();
  const fractional = JSON.stringify({ version: 1, ...size, height: size.height + 1, maximized: false }) + '\n';
  await writeFile(join(profile, 'window-state.json'), fractional);
  let initial;
  for (let run = 0; run < 3; run++) {
    await launch();
    const current = await state();
    if (run === 0) initial = current; else assert.deepEqual(current, initial);
    await close();
    assert.equal(await readFile(join(profile, 'window-state.json'), 'utf8'), fractional);
  }
  console.log('Arbitrary fractional-DPI dimensions and saved preferences stayed stable across three launches: ' + JSON.stringify(initial));

  await close();
  await writeFile(join(profile, 'window-state.json'), '{broken');
  await launch();
  const fallback = await state();
  assert.equal(fallback.maximized, false);
  assert.ok(fallback.width > 0 && fallback.width <= workArea.width);
  assert.ok(fallback.height > 0 && fallback.height <= workArea.height);
  console.log('AppImage window state passed: normal resize/relaunch, maximized relaunch, original normal bounds, subsequent resize, minimized/fullscreen close from both modes, fractional-DPI no-growth, and damaged-preference recovery.');
} finally {
  await close();
  await rm(stage, { recursive: true, force: true });
}
