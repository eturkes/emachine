import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { createUpdateController, registerUpdateIpc } from '../desktop/updates.cjs';

function fixture(options = {}) {
  const updater = new EventEmitter();
  const calls = [];
  updater.checkForUpdates = async () => { calls.push('check'); updater.emit('update-available', { version: '0.2.0' }); return {}; };
  updater.downloadUpdate = async () => { calls.push('download'); updater.emit('download-progress', { percent: 42.4 }); updater.emit('update-downloaded', { version: '0.2.0' }); return ['fixture.AppImage']; };
  updater.quitAndInstall = (...args) => calls.push(['install', ...args]);
  const states = [];
  const controller = createUpdateController({ updater, version: '0.1.0', supported: true, notify: state => states.push(state), ...options });
  return { updater, calls, states, controller };
}

test('updates require separate check, download and restart actions', async () => {
  const { controller: c, updater: u, calls, states } = fixture();
  assert.deepEqual(calls, []);
  assert.equal(u.autoDownload, false); assert.equal(u.autoInstallOnAppQuit, false);
  assert.equal(u.allowPrerelease, false); assert.equal(u.allowDowngrade, false);
  await c.download(); await c.install(); assert.deepEqual(calls, []);
  assert.equal((await c.check()).status, 'available'); assert.deepEqual(calls, ['check']);
  await c.install(); assert.deepEqual(calls, ['check']);
  assert.equal((await c.download()).status, 'downloaded');
  assert.deepEqual(calls, ['check', 'download']);
  assert.equal(states.find(state => state.percent === 42)?.status, 'downloading');
  await c.check(); await c.download(); assert.deepEqual(calls, ['check', 'download']);
  assert.equal((await c.install()).status, 'installing');
  await c.install(); assert.deepEqual(calls, ['check', 'download', ['install', false, true]]);
});

test('concurrent clicks cannot start another operation', async () => {
  const { controller: c, updater: u } = fixture();
  let finish; let checks = 0;
  u.checkForUpdates = () => { checks++; return new Promise(resolve => { finish = resolve; }); };
  const pending = c.check();
  assert.equal((await c.check()).status, 'checking');
  await c.download(); await c.install(); assert.equal(checks, 1);
  u.emit('update-not-available'); finish({}); await pending;
  assert.equal(c.getState().status, 'current');
});

test('missing metadata, offline errors and failed checks are retryable without leaking upstream details', async () => {
  const { controller: c, updater: u } = fixture();
  for (const error of [Object.assign(new Error('private path or token'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' }), new Error('private path or token')]) {
    u.checkForUpdates = async () => { u.emit('error', error); throw error; };
    const state = await c.check(); assert.equal(state.status, 'error');
    assert.doesNotMatch(state.message, /private path|token/);
    assert.match(state.message, error.code ? /no update information/ : /internet connection/);
  }
  u.checkForUpdates = async () => { u.emit('update-not-available'); return {}; };
  assert.equal((await c.check()).status, 'current');
});

test('read-only locations block downloads and recheck permissions before installation', async () => {
  let writable = false;
  const f = fixture({ writable: async () => { if (!writable) throw Object.assign(new Error('private path'), { code: 'EACCES' }); } });
  await f.controller.check();
  assert.match((await f.controller.download()).message, /not writable/);
  assert.deepEqual(f.calls, ['check']);
  writable = true; await f.controller.check(); await f.controller.download();
  writable = false;
  assert.match((await f.controller.install()).message, /not writable/);
  assert.deepEqual(f.calls, ['check', 'check', 'download']);
});

test('checksum failures never allow installation and can retry', async () => {
  const { controller: c, updater: u, calls } = fixture();
  await c.check();
  u.downloadUpdate = async () => { throw new Error('sha512 checksum mismatch'); };
  assert.match((await c.download()).message, /integrity check/);
  await c.install(); assert.deepEqual(calls, ['check']);
  assert.equal((await c.check()).status, 'available');
});

test('installation errors stay visible and do not report success', async () => {
  const { controller: c, updater: u } = fixture();
  await c.check(); await c.download();
  u.quitAndInstall = () => u.emit('error', new Error('install failed'));
  assert.equal((await c.install()).status, 'error');
});

test('unsupported clients make no update requests; state snapshots are independent', async () => {
  const { controller: c, calls } = fixture({ supported: false });
  c.getState().status = 'available';
  await c.check(); await c.download(); await c.install();
  assert.equal(c.getState().status, 'unsupported'); assert.deepEqual(calls, []);
});

test('only the packaged shell main frame can invoke update IPC', () => {
  const handlers = new Map();
  const contents = { mainFrame: { url: 'emachine://app/index.html' } };
  const controller = Object.fromEntries(['getState', 'check', 'download', 'install'].map(name => [name, () => name]));
  registerUpdateIpc({ handle: (name, handler) => handlers.set(name, handler) }, { webContents: contents }, controller);
  assert.equal(handlers.size, 4);
  for (const [name, handler] of handlers) {
    const valid = { sender: contents, senderFrame: contents.mainFrame };
    assert.equal(handler(valid), name.split(':').at(-1));
    for (const invalid of [{ sender: {}, senderFrame: contents.mainFrame }, { sender: contents, senderFrame: { url: contents.mainFrame.url } }, { sender: contents, senderFrame: null }]) {
      assert.throws(() => handler(invalid), /access denied/);
    }
    contents.mainFrame.url = 'https://untrusted.invalid/';
    assert.throws(() => handler(valid), /access denied/);
    contents.mainFrame.url = 'emachine://app/index.html';
  }
});
