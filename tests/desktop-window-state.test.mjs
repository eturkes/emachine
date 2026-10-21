import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const mainPath = fileURLToPath(new URL('../desktop/main.cjs', import.meta.url));
const require = createRequire(mainPath);
const normal = { version: 1, width: 1010, height: 710, maximized: false };
const plain = value => JSON.parse(JSON.stringify(value));

async function fixture(t, { saved, workArea = { width: 1920, height: 1080 }, failure, initialRounding = 0 } = {}) {
  const profile = fs.mkdtempSync(join(tmpdir(), 'emachine-window-unit-'));
  const file = join(profile, 'window-state.json');
  if (saved !== undefined) fs.writeFileSync(file, typeof saved === 'string' ? saved : JSON.stringify(saved));
  let ready, now = 0, nextTimer = 0;
  const timers = new Map(), actions = [], warnings = [];
  const clock = {
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, at: now + delay, interval: delay }); return id; },
    clearInterval(id) { timers.delete(id); },
  };
  let window;
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super(); window = this; this.options = plain(options);
      this.normal = { x: 0, y: 0, width: options.width, height: options.height + initialRounding };
      this.maximized = false; this.minimized = false; this.fullscreen = false; this.destroyed = false;
      this.webContents = { on() {}, setWindowOpenHandler() {}, send() {} };
    }
    setMenu() {} setMenuBarVisibility() {}
    getNormalBounds() { return this.unreliableNormal && (this.maximized || this.minimized || this.fullscreen)
      ? { x: 0, y: 0, ...workArea } : { ...this.normal }; }
    getBounds() { return this.maximized || this.fullscreen ? { x: 0, y: 0, ...workArea } : this.getNormalBounds(); }
    isMaximized() { return this.maximized; }
    isMinimized() { return this.minimized; }
    isFullScreen() { return this.fullscreen; }
    isDestroyed() { return this.destroyed; }
    show() { actions.push('show'); }
    maximize() { this.maximized = true; actions.push('maximize'); this.emit('resize'); this.emit('maximize'); }
    unmaximize() { this.maximized = false; this.emit('unmaximize'); this.emit('resize'); }
    resize(width, height) { this.normal.width = width; this.normal.height = height; this.emit('resize'); }
    close() { this.emit('close'); this.destroyed = true; this.emit('closed'); }
  }
  const electron = {
    app: { setName() {}, on() {}, getPath: () => profile, requestSingleInstanceLock: () => true,
      whenReady: () => ({ then: start => (ready = start()) }) },
    BrowserWindow, screen: { getPrimaryDisplay: () => ({ workAreaSize: workArea }) },
    protocol: { registerSchemesAsPrivileged() {}, handle() {} },
    session: { defaultSession: { setPermissionCheckHandler() {}, setPermissionRequestHandler() {} } },
    Menu: { buildFromTemplate() {} }, dialog: {}, ipcMain: {},
  };
  const context = { __dirname: dirname(mainPath), URL, console: { warn: (...args) => warnings.push(args), error: console.error }, ...clock };
  context.require = name => {
    if (name === 'electron') return electron;
    if (name === './storage.cjs') return { configureDesktopStorage() {} };
    if (name === './interface.cjs') return {
      createInterfaceController: async () => ({
        async start() { window.emit('resize'); window.emit('unmaximize'); window.emit('ready-to-show'); },
        dispose() {}, check() {},
      }),
      registerInterfaceIpc() {},
    };
    if (name === './window-state.cjs') {
      const module = { exports: {} };
      const filesystem = { ...fs,
        writeFileSync(...args) {
          if (failure === 'write') {
            fs.writeFileSync(args[0], 'partial');
            throw Object.assign(new Error('full disk'), { code: 'ENOSPC' });
          }
          return fs.writeFileSync(...args);
        },
        renameSync(...args) {
          if (failure === 'rename') throw Object.assign(new Error('read only'), { code: 'EROFS' });
          return fs.renameSync(...args);
        },
      };
      runInNewContext(fs.readFileSync(join(dirname(mainPath), 'window-state.cjs'), 'utf8'), {
        module, require: id => id === 'node:fs' ? filesystem : require(id), console: context.console, ...clock,
      });
      return module.exports;
    }
    return require(name);
  };
  runInNewContext(fs.readFileSync(mainPath, 'utf8'), context);
  await ready;
  t.after(() => {
    if (!window.destroyed) window.close();
    fs.rmSync(profile, { recursive: true, force: true });
  });
  return { window, profile, file, actions, warnings, timers,
    read: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) {
        timers.delete(id); timer.fn();
        if (timer.interval) timers.set(id, { ...timer, at: now + timer.interval });
      }
    },
  };
}

test('restores saved normal dimensions before showing the main window', async t => {
  const f = await fixture(t, { saved: normal });
  assert.equal(f.window.options.width, normal.width);
  assert.equal(f.window.options.height, normal.height);
  assert.deepEqual(f.actions, ['show']);
});

test('startup events preserve maximized state and original normal dimensions', async t => {
  const f = await fixture(t, { saved: { ...normal, maximized: true } });
  assert.deepEqual(f.actions, ['show', 'maximize']);
  assert.deepEqual(f.window.getNormalBounds(), { x: 0, y: 0, width: normal.width, height: normal.height });
  f.window.close();
  assert.deepEqual(f.read(), { ...normal, maximized: true });
});

test('startup DPI rounding never feeds back into saved dimensions, but a later resize does', async t => {
  for (const maximized of [false, true]) {
    const f = await fixture(t, { saved: { ...normal, maximized }, initialRounding: 3 });
    f.window.emit('resize'); f.advance(250);
    assert.deepEqual(f.read(), { ...normal, maximized });
    f.window.close();
    assert.deepEqual(f.read(), { ...normal, maximized });
  }
  const f = await fixture(t, { saved: normal, initialRounding: 3 });
  f.window.resize(1020, 720); f.advance(250);
  assert.deepEqual(f.read(), { ...normal, width: 1020, height: 720 });
  f.window.resize(normal.width, normal.height + 3); f.window.close();
  assert.deepEqual(f.read(), { ...normal, height: normal.height + 3 });
});

test('special-state native bounds cannot replace a normal resize that has not been flushed', async t => {
  for (const mode of ['maximized', 'minimized', 'fullscreen']) {
    const f = await fixture(t, { saved: normal });
    f.window.resize(1050, 730);
    f.window.unreliableNormal = true;
    if (mode === 'maximized') f.window.maximize(); else f.window[mode] = true;
    f.window.emit('resize'); f.window.close();
    assert.deepEqual(f.read(), { ...normal, width: 1050, height: 730, maximized: mode === 'maximized' });
  }
});

test('resize is debounced and close synchronously saves the newest normal size', async t => {
  const f = await fixture(t, { saved: normal });
  f.window.resize(1110, 740); f.advance(249);
  assert.deepEqual(f.read(), normal);
  f.advance(1);
  assert.deepEqual(f.read(), { ...normal, width: 1110, height: 740 });
  f.window.resize(980, 680); f.window.close();
  assert.deepEqual(f.read(), { ...normal, width: 980, height: 680 });
  assert.equal(f.timers.size, 0);
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
});

test('unmaximize and later resize replace the saved state', async t => {
  const f = await fixture(t, { saved: { ...normal, maximized: true } });
  f.window.unmaximize(); f.window.resize(1040, 720); f.window.close();
  assert.deepEqual(f.read(), { ...normal, width: 1040, height: 720 });
});

for (const mode of ['minimized', 'fullscreen']) for (const maximized of [false, true]) {
  test(mode + ' close retains normal dimensions and previous maximized=' + maximized, async t => {
    const f = await fixture(t, { saved: normal });
    f.window.resize(1060, 730);
    if (maximized) f.window.maximize();
    f.window[mode] = true;
    f.window.maximized = false;
    f.window.emit('unmaximize');
    f.window.emit(mode === 'minimized' ? 'minimize' : 'enter-full-screen');
    f.window.close();
    assert.deepEqual(f.read(), { ...normal, width: 1060, height: 730, maximized });
  });
}

test('missing or damaged preferences use safe defaults', async t => {
  for (const saved of [undefined, '{broken', 'null', { ...normal, version: 2 }, { ...normal, width: 0 },
    { ...normal, height: -1 }, { ...normal, width: 1.5 }, { ...normal, width: '1010' },
    { ...normal, width: Number.MAX_SAFE_INTEGER + 1 }, { ...normal, maximized: 'true' }]) {
    const f = await fixture(t, { saved });
    assert.equal(f.window.options.width, 1320);
    assert.equal(f.window.options.height, 860);
    assert.deepEqual(f.actions, ['show']);
  }
});

test('saved dimensions and minimum constraints fit the current display', async t => {
  for (const workArea of [{ width: 800, height: 600 }, { width: 320, height: 240 }]) {
    const f = await fixture(t, { saved: { ...normal, width: 10000, height: 10000 }, workArea });
    assert.equal(f.window.options.width, workArea.width);
    assert.equal(f.window.options.height, workArea.height);
    assert.equal(f.window.options.minWidth, Math.min(420, workArea.width));
    assert.equal(f.window.options.minHeight, Math.min(380, workArea.height));
  }
  const f = await fixture(t, { saved: { ...normal, width: 1, height: 1 } });
  assert.equal(f.window.options.width, 420);
  assert.equal(f.window.options.height, 380);
});

for (const failure of ['write', 'rename']) {
  test(failure + ' failure preserves old preferences and removes owned temporary files', async t => {
    const f = await fixture(t, { saved: normal, failure });
    f.window.resize(1090, 740);
    assert.doesNotThrow(() => f.window.close());
    assert.deepEqual(f.read(), normal);
    assert.deepEqual(fs.readdirSync(f.profile), ['window-state.json']);
    assert.equal(f.warnings.length, 1);
  });
}

test('independent configured profiles retain independent window states', async t => {
  const first = await fixture(t, { saved: normal });
  const second = await fixture(t, { saved: { ...normal, width: 1150, height: 750, maximized: true } });
  first.window.resize(950, 650); first.window.close(); second.window.close();
  assert.deepEqual(first.read(), { ...normal, width: 950, height: 650 });
  assert.deepEqual(second.read(), { ...normal, width: 1150, height: 750, maximized: true });
});
