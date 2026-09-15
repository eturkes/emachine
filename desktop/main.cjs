'use strict';
const { app, BrowserWindow, protocol, net, session, dialog, ipcMain, Menu } = require('electron');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { autoUpdater } = require('electron-updater');
const { createUpdateController, registerUpdateIpc, writableAppImage } = require('./updates.cjs');
const { createInterfaceController, registerInterfaceIpc } = require('./interface.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'emachine', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true,
} }]);
app.setName('emachine');
let main;
const mediaGrants = new Set();
const SHELL_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https: wss: http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*; frame-src https: http://127.0.0.1:* http://localhost:*; img-src 'self' data: blob:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

app.on('login', (event, contents, details, authInfo, callback) => {
  event.preventDefault();
  if (contents !== main?.webContents || authInfo.isProxy || !details.url.startsWith('https://')) { callback(); return; }
  const channel = `emachine-auth-${randomUUID()}`;
  const prompt = new BrowserWindow({
    parent: main, modal: true, width: 440, height: 340, resizable: false, show: false,
    title: `Sign in to ${new URL(details.url).host}`,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true,
      preload: join(__dirname, 'auth-preload.cjs'), additionalArguments: [channel] },
  });
  let finished = false;
  const finish = credentials => {
    if (finished) return;
    finished = true;
    ipcMain.removeAllListeners(channel);
    if (credentials) callback(credentials.username, credentials.password); else callback();
    if (!prompt.isDestroyed()) prompt.close();
  };
  ipcMain.on(channel, (incoming, credentials) => {
    if (incoming.sender !== prompt.webContents || incoming.senderFrame !== prompt.webContents.mainFrame) return;
    if (credentials && typeof credentials.username === 'string' && typeof credentials.password === 'string' && credentials.username.length < 1000 && credentials.password.length < 1000) finish(credentials);
    else finish();
  });
  prompt.on('closed', () => finish());
  prompt.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  prompt.webContents.on('will-navigate', event => event.preventDefault());
  prompt.once('ready-to-show', () => prompt.show());
  void prompt.loadFile(join(__dirname, 'auth.html'), { query: { host: new URL(details.url).host } });
});

async function start() {
  const root = resolve(__dirname, '../web/dist');
  let ui;
  protocol.handle('emachine', async request => {
    const url = new URL(request.url);
    if (url.host !== 'app' || request.method !== 'GET') return new Response('Not found', { status: 404 });
    let path;
    try { path = decodeURIComponent(url.pathname); } catch { return new Response('Invalid path', { status: 400 }); }
    if (path.includes('\\') || path.includes('\0') || path.split('/').includes('..')) return new Response('Invalid path', { status: 400 });
    const file = ui.assetPath(path === '/' ? 'index.html' : path.slice(1));
    if (!file) return new Response('Not found', { status: 404 });
    if (path === '/bootstrap.json') {
      // This optional file contains only machine addresses, never credentials.
      try { return await net.fetch(pathToFileURL(file).href); } catch { return Response.json({ servers: [] }); }
    }
    try {
      const source = await net.fetch(pathToFileURL(file).href);
      const headers = new Headers(source.headers);
      headers.set('Content-Security-Policy', SHELL_CSP);
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('Cache-Control', 'no-store');
      return new Response(source.body, { status: source.status, headers });
    } catch { return new Response('Not found', { status: 404 }); }
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission, origin) =>
    permission === 'media' && mediaGrants.has(origin));
  session.defaultSession.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    const origin = details.requestingUrl ? new URL(details.requestingUrl).origin : '';
    if (contents !== main?.webContents || permission !== 'media' || !origin.startsWith('https://')) { callback(false); return; }
    const result = await dialog.showMessageBox(main, { type: 'question', title: 'Media access',
      message: `Allow camera or microphone access for ${origin}?`,
      detail: 'Only allow this for a feature you requested.', buttons: ['Deny', 'Allow'], defaultId: 0, cancelId: 0 });
    if (result.response === 1) mediaGrants.add(origin);
    callback(result.response === 1);
  });
  main = new BrowserWindow({
    width: 1320, height: 860, minWidth: 420, minHeight: 380,
    title: 'emachine', backgroundColor: '#0c1218', show: false, autoHideMenuBar: true,
    icon: join(root, 'icons/512.png'),
    webPreferences: { nodeIntegration: false, nodeIntegrationInSubFrames: false,
      contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false,
      preload: join(__dirname, 'preload.cjs') },
  });
  const updates = createUpdateController({ updater: autoUpdater, version: app.getVersion(),
    supported: app.isPackaged && process.platform === 'linux' && Boolean(process.env.APPIMAGE),
    writable: () => writableAppImage(process.env.APPIMAGE),
    notify: state => { if (!main.isDestroyed()) main.webContents.send('emachine:update:state', state); },
  });
  registerUpdateIpc(ipcMain, main, updates);
  ui = await createInterfaceController({ bundleRoot: root, cacheRoot: join(app.getPath('userData'), 'interface'),
    fetch: (url, options) => net.fetch(url, options),
    reload: () => main.loadURL('emachine://app/index.html'),
    notify: state => { if (!main.isDestroyed()) main.webContents.send('emachine:interface:state', state); },
    confirmSource: async source => (await dialog.showMessageBox(main, { type: 'warning', title: 'Trust interface source',
      message: source ? 'Trust this server to replace the application interface?' : 'Stop checking the interface server?',
      detail: source ? `Interface code can access your connected machines. Only trust a server you control.\n\n${source}` : 'Your saved interface remains available.',
      buttons: ['Cancel', 'Trust source'], defaultId: 0, cancelId: 0 })).response === 1,
  });
  registerInterfaceIpc(ipcMain, main, ui);
  // Native recovery remains reachable when a downloaded renderer cannot display its controls.
  main.setMenu(Menu.buildFromTemplate([{ label: 'Interface', submenu: [
    { label: 'Refresh interface', accelerator: 'CommandOrControl+Shift+R', click: () => { void ui.refresh(); } },
    { label: 'Use bundled interface', accelerator: 'CommandOrControl+Shift+B', click: async () => {
      const answer = await dialog.showMessageBox(main, { type: 'question', title: 'Restore bundled interface',
        message: 'Reload the bundled interface?', detail: 'Save work in open views first. Server terminals and jobs keep running.',
        buttons: ['Cancel', 'Reload'], defaultId: 0, cancelId: 0 });
      if (answer.response === 1) await ui.restore();
    } },
  ] }]));
  main.setMenuBarVisibility(false);
  main.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  main.webContents.on('will-navigate', event => event.preventDefault());
  main.webContents.on('will-attach-webview', event => event.preventDefault());
  main.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) void ui.loadFailed();
  });
  main.webContents.on('render-process-gone', () => { void ui.loadFailed(); });
  main.once('ready-to-show', () => main.show());
  await ui.start();
  const initialCheck = setTimeout(() => { void ui.check(); }, 1000);
  const checks = setInterval(() => { void ui.check(); }, 60000);
  main.on('closed', () => { clearTimeout(initialCheck); clearInterval(checks); ui.dispose(); });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (main) { if (main.isMinimized()) main.restore(); main.show(); main.focus(); } });
  app.whenReady().then(start).catch(error => { console.error(error); app.quit(); });
  app.on('window-all-closed', () => app.quit());
}
