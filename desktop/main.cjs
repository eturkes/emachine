'use strict';
const { app, BrowserWindow, protocol, net, session, dialog, ipcMain } = require('electron');
const { join, resolve, sep } = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');

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
  protocol.handle('emachine', async request => {
    const url = new URL(request.url);
    if (url.host !== 'app' || request.method !== 'GET') return new Response('Not found', { status: 404 });
    let path;
    try { path = decodeURIComponent(url.pathname); } catch { return new Response('Invalid path', { status: 400 }); }
    if (path.includes('\\') || path.includes('\0') || path.split('/').includes('..')) return new Response('Invalid path', { status: 400 });
    const file = resolve(root, '.' + (path === '/' ? '/index.html' : path));
    if (!file.startsWith(root + sep)) return new Response('Not found', { status: 404 });
    if (path === '/bootstrap.json') {
      // This optional file contains only machine addresses, never credentials.
      try { return await net.fetch(pathToFileURL(file).href); } catch { return Response.json({ servers: [] }); }
    }
    try {
      const source = await net.fetch(pathToFileURL(file).href);
      const headers = new Headers(source.headers);
      headers.set('Content-Security-Policy', SHELL_CSP);
      headers.set('X-Content-Type-Options', 'nosniff');
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
    title: 'emachine', backgroundColor: '#0c1218', show: false,
    icon: join(root, 'icons/512.png'),
    webPreferences: { nodeIntegration: false, nodeIntegrationInSubFrames: false,
      contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false },
  });
  main.removeMenu();
  main.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  main.webContents.on('will-navigate', event => event.preventDefault());
  main.webContents.on('will-attach-webview', event => event.preventDefault());
  main.once('ready-to-show', () => main.show());
  await main.loadURL('emachine://app/index.html');
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (main) { if (main.isMinimized()) main.restore(); main.show(); main.focus(); } });
  app.whenReady().then(start).catch(error => { console.error(error); app.quit(); });
  app.on('window-all-closed', () => app.quit());
}
