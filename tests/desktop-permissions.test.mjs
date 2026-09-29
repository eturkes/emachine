import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const mainPath = fileURLToPath(new URL('../desktop/main.cjs', import.meta.url));
const require = createRequire(mainPath);
const shellUrl = 'emachine://app/index.html';
async function fixture() {
  let ready, check, request;
  const f = { url: shellUrl, prompts: 0, answer: 0 };
  f.contents = { getURL: () => f.url, isDestroyed: () => false,
    setWindowOpenHandler() {}, on() {} };
  class BrowserWindow {
    webContents = f.contents;
    setMenu() {} setMenuBarVisibility() {} once() {} on() {}
  }
  const electron = {
    app: { setName() {}, on() {}, getPath: () => '/fixture/profile', requestSingleInstanceLock: () => true,
      whenReady: () => ({ then: start => (ready = start()) }) },
    BrowserWindow, protocol: { registerSchemesAsPrivileged() {}, handle() {} },
    session: { defaultSession: {
      setPermissionCheckHandler: handler => { check = handler; },
      setPermissionRequestHandler: handler => { request = handler; },
    } },
    dialog: { showMessageBox: async () => { f.prompts++; return { response: f.answer }; } },
    Menu: { buildFromTemplate() {} },
  };
  runInNewContext(readFileSync(mainPath, 'utf8'), {
    require: name => name === 'electron' ? electron
      : name === './storage.cjs' ? { configureDesktopStorage() {} }
      : name === './interface.cjs' ? { createInterfaceController: async () => ({ async start() {} }), registerInterfaceIpc() {} }
      : require(name),
    __dirname: dirname(mainPath), URL, console,
    setTimeout() {}, setInterval() {}, clearTimeout() {}, clearInterval() {},
  });
  await ready;
  f.check = (contents, permission, origin, details) => check(contents, permission, origin, details);
  f.request = async (contents, permission, details) => {
    let calls = 0, result;
    await request(contents, permission, value => { calls++; result = value; }, details);
    assert.equal(calls, 1, 'Each permission request must resolve exactly once.');
    return result;
  };
  return f;
}

for (const permission of ['clipboard-sanitized-write', 'clipboard-read']) {
  test(`the shell allows ${permission} in both permission handlers`, async () => {
    const f = await fixture();
    const details = { requestingUrl: shellUrl, isMainFrame: true };
    const check = f.check(f.contents, permission, 'emachine://app', details);
    const request = await f.request(f.contents, permission, details);
    assert.deepEqual({ check, request }, { check: true, request: true });
    assert.equal(f.prompts, 0);
  });
  for (const [label, overrides] of [
    ['feature frame', { requestingUrl: 'https://feature.example/', isMainFrame: false }],
    ['same-origin subframe', { isMainFrame: false }],
    ['missing frame identity', { isMainFrame: undefined }],
    ['remote main frame', { requestingUrl: 'https://feature.example/' }],
    ['lookalike host', { requestingUrl: 'emachine://app.example/index.html' }],
    ['credentials', { requestingUrl: 'emachine://user@app/index.html' }],
    ['port', { requestingUrl: 'emachine://app:123/index.html' }],
    ['wrong scheme', { requestingUrl: 'https://app/index.html' }],
    ['opaque frame', { requestingUrl: 'about:blank' }],
    ['malformed URL', { requestingUrl: 'not a URL' }],
    ['missing URL', { requestingUrl: undefined }],
    ['another window', { anotherWindow: true }],
    ['no web contents', { noContents: true }],
    ['navigated shell', { shellLocation: 'https://feature.example/' }],
  ]) {
    test(`${permission} rejects ${label}`, async () => {
      const f = await fixture();
      const { anotherWindow, noContents, shellLocation, ...changes } = overrides;
      if (shellLocation) f.url = shellLocation;
      const contents = noContents ? null : anotherWindow ? { ...f.contents } : f.contents;
      const details = { requestingUrl: shellUrl, isMainFrame: true, ...changes };
      assert.equal(f.check(contents, permission, 'emachine://app', details), false);
      assert.equal(await f.request(contents, permission, details), false);
      assert.equal(f.prompts, 0);
    });
  }
  test(`${permission} rejects a mismatched permission-check origin`, async () => {
    const f = await fixture();
    assert.equal(f.check(f.contents, permission, 'https://feature.example/',
      { requestingUrl: shellUrl, isMainFrame: true }), false);
  });
}

test('unrelated permissions remain denied', async () => {
  const f = await fixture();
  for (const permission of ['notifications', 'geolocation', 'display-capture', 'openExternal', 'unknown']) {
    const details = { requestingUrl: shellUrl, isMainFrame: true };
    assert.equal(f.check(f.contents, permission, 'emachine://app', details), false);
    assert.equal(await f.request(f.contents, permission, details), false);
  }
  assert.equal(f.prompts, 0);
});

test('HTTPS feature media still requires the existing explicit approval', async () => {
  const f = await fixture();
  const details = { requestingUrl: 'https://feature.example/view', isMainFrame: false };
  assert.equal(f.check(f.contents, 'media', 'https://feature.example', details), false);
  assert.equal(await f.request(f.contents, 'media', details), false);
  f.answer = 1;
  assert.equal(await f.request(f.contents, 'media', details), true);
  assert.equal(f.check(f.contents, 'media', 'https://feature.example', details), true);
  assert.equal(f.prompts, 2);
});
