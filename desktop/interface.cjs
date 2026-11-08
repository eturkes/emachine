'use strict';
const { readFile, writeFile, mkdir, mkdtemp, rename, rm, readdir, lstat } = require('node:fs/promises');
const { join, dirname } = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { MANIFEST, MAX_MANIFEST, digest, isDigest, assetPath, sourceUrl, validateManifest, failure } = require('./interface-manifest.cjs');

const transientStatus = new Set([408, 429, 500, 502, 503, 504]);

async function localBytes(path, limit) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > limit) throw failure('UI_CACHE', 'The cached interface is invalid.');
  const bytes = await readFile(path);
  if (bytes.length > limit) throw failure('UI_CACHE', 'The cached interface is invalid.');
  return bytes;
}
async function localRelease(root) {
  const manifest = validateManifest(JSON.parse(await localBytes(join(root, MANIFEST), MAX_MANIFEST)));
  for (const file of manifest.files) {
    const bytes = await localBytes(join(root, file.path), file.bytes);
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw failure('UI_CACHE', 'The cached interface failed its integrity check.');
  }
  return { root, manifest };
}
async function atomicJson(path, value) {
  const pending = path + '.pending-' + randomUUID();
  try { await writeFile(pending, JSON.stringify(value) + '\n', { mode: 0o600 }); await rename(pending, path); }
  finally { await rm(pending, { force: true }); }
}
function errorMessage(error) {
  if (typeof error?.code === 'string' && error.code.startsWith('UI_')) return error.message;
  if (error?.code === 'ENOSPC') return 'There is not enough disk space. The current interface is unchanged.';
  if (['EACCES', 'EPERM', 'EROFS'].includes(error?.code)) return 'The desktop interface cache is not writable. Check its permissions.';
  return 'The interface could not refresh. Check the trusted server and your connection. Your saved interface remains available.';
}

function downloadReason(error) {
  if (typeof error?.code === 'string' && error.code.startsWith('UI_')) return error.message;
  // Electron reports Chromium network errors in the message. Do not display arbitrary exception text.
  if (/^net::ERR_CERT_[A-Z_]+$/.test(error?.message)) return 'The server certificate failed verification.';
  switch (error?.message) {
    case 'net::ERR_NAME_NOT_RESOLVED': return 'DNS could not resolve the server name.';
    case 'net::ERR_CONNECTION_REFUSED': return 'The server refused the connection.';
    case 'net::ERR_CONNECTION_TIMED_OUT':
    case 'net::ERR_TIMED_OUT': return 'The network connection timed out.';
    case 'net::ERR_CONNECTION_RESET': return 'The connection was reset during the download.';
    case 'net::ERR_ADDRESS_UNREACHABLE':
    case 'net::ERR_INTERNET_DISCONNECTED': return 'The server is unreachable from this device.';
    default: return 'The network request failed. Check the source address and the connection from this device.';
  }
}

async function createInterfaceController({ bundleRoot, cacheRoot, fetch: request = globalThis.fetch,
  confirmSource = async () => false, reload = async () => {}, notify = () => {}, readyTimeoutMs = 15000 }) {
  const bundle = await localRelease(bundleRoot);
  const releases = join(cacheRoot, 'releases'); const settings = join(cacheRoot, 'state.json');
  let cacheAvailable = true;
  try { await mkdir(releases, { recursive: true, mode: 0o700 }); }
  catch { cacheAvailable = false; }
  let config = { source: '', good: null, previous: null };
  try {
    const saved = JSON.parse(await localBytes(settings, 8192));
    config = { source: saved.source ? sourceUrl(saved.source).href : '',
      good: isDigest(saved.good) ? saved.good : null, previous: isDigest(saved.previous) ? saved.previous : null };
  } catch { /* A missing or corrupt pointer cannot replace the bundled recovery interface. */ }
  let active = bundle;
  let recovered = false;
  for (const revision of config.good ? [config.good, config.previous] : []) {
    if (!revision) continue;
    try {
      const saved = await localRelease(join(releases, revision));
      if (saved.manifest.revision !== revision) throw failure('UI_CACHE', 'The cached revision is invalid.');
      active = saved; break;
    }
    catch { recovered = true; }
  }
  config.good = active === bundle ? null : active.manifest.revision;
  let fallback = bundle;
  if (config.good && config.previous && config.good !== config.previous) {
    try {
      const previous = await localRelease(join(releases, config.previous));
      if (previous.manifest.revision === config.previous) fallback = previous;
    } catch { /* Bundled recovery remains available when the previous cache is damaged. */ }
  }
  let state = { status: config.source ? 'idle' : 'unconfigured', message: recovered ?
    'The saved interface was invalid. A verified recovery interface is open.' : 'Choose a trusted server for interface updates.' };
  let busy = false; let pending; let timer; let disposed = false; let token = randomUUID();
  let transitions = 0; let transition = Promise.resolve();
  const serialize = operation => {
    transitions++;
    const result = transition.then(operation).finally(() => { transitions--; });
    transition = result.catch(() => {});
    return result;
  };
  const getState = () => ({ ...state, source: config.source, revision: active.manifest.revision, bundled: active === bundle, cacheAvailable });
  const set = (status, message, extra = {}) => { state = { status, message, ...extra }; if (!disposed) notify(getState()); };
  const save = async next => { await atomicJson(settings, next); config = next; };
  const cacheError = () => set('error', 'The interface cache is unavailable. The saved interface remains open. Check disk space and app data permissions, then reopen the app.');
  async function prune() {
    const keep = new Set([config.good, config.previous, active.manifest.revision, fallback.manifest.revision]);
    for (const entry of await readdir(releases, { withFileTypes: true })) {
      if (entry.isDirectory() && isDigest(entry.name) && !keep.has(entry.name)) await rm(join(releases, entry.name), { recursive: true, force: true });
    }
    for (const entry of await readdir(cacheRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('.stage-')) await rm(join(cacheRoot, entry.name), { recursive: true, force: true });
    }
  }
  async function clean() {
    // A recovery renderer can become ready while another operation is still downloading.
    if (!cacheAvailable || busy) return;
    try { await prune(); } catch { cacheAvailable = false; }
  }
  await clean();
  if (!cacheAvailable) cacheError();
  async function fetchOnce(url, limit, deadline) {
    const idle = new AbortController();
    const signal = AbortSignal.any([deadline, idle.signal]);
    const timer = setTimeout(() => idle.abort(), 30_000);
    try {
      const response = await request(url.href, { redirect: 'error', credentials: 'omit', cache: 'no-store',
        headers: { Origin: 'emachine://app' }, signal });
      timer.refresh();
      const wrongUrl = response.url && response.url !== url.href;
      if (!response.ok || wrongUrl) {
        await response.body?.cancel();
        const retry = !wrongUrl && transientStatus.has(response.status);
        throw failure(retry ? 'UI_TRANSIENT' : 'UI_NETWORK', wrongUrl ? 'The response came from a different address.' : `The server returned HTTP ${response.status}.`);
      }
      if (Number(response.headers.get('content-length')) > limit) {
        await response.body?.cancel(); throw failure('UI_SIZE', 'The interface download exceeds its size limit.');
      }
      const reader = response.body?.getReader();
      if (!reader) throw failure('UI_NETWORK', 'The interface download was empty.');
      const chunks = []; let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          if (!value.length) continue;
          size += value.length;
          if (size > limit) throw failure('UI_SIZE', 'The interface download exceeds its size limit.');
          timer.refresh();
          chunks.push(Buffer.from(value));
        }
      } finally { await reader.cancel().catch(() => {}); }
      return Buffer.concat(chunks, size);
    } catch (error) {
      if (idle.signal.aborted) throw failure('UI_TRANSIENT', 'The download stalled for 30 seconds.');
      throw error;
    } finally { clearTimeout(timer); }
  }
  async function fetchBytes(path, limit, { deadline, attempts, timeoutMs }, expectedHash) {
    const url = new URL(path, sourceUrl(config.source));
    for (let attempt = 1; ; attempt++) {
      try {
        deadline.throwIfAborted();
        if (attempt > 1) await delay(500 * (attempt - 1), undefined, { signal: deadline });
        const bytes = await fetchOnce(url, limit, deadline);
        if (expectedHash) {
          if (bytes.length < limit) throw failure('UI_TRANSIENT', 'The interface download ended early. Try the refresh again.');
          if (digest(bytes) !== expectedHash) throw failure('UI_DIGEST', 'The interface failed its integrity check. The current interface is unchanged.');
        }
        return bytes;
      } catch (error) {
        // Fetch and body-read errors can be transient. Our own validation errors are final.
        if (attempt >= attempts || deadline.aborted ||
            (String(error?.code).startsWith('UI_') && error.code !== 'UI_TRANSIENT')) {
          const reason = deadline.aborted ? `The ${timeoutMs / 1000}-second time limit was reached.` : downloadReason(error);
          throw failure('UI_DOWNLOAD', `Could not download ${path} from ${url.host}. ${reason}`);
        }
      }
    }
  }
  async function probe(transfer) {
    const bytes = await fetchBytes(MANIFEST, MAX_MANIFEST, transfer);
    let metadata;
    try { metadata = JSON.parse(bytes); }
    catch { throw failure('UI_MANIFEST', 'The interface manifest contains invalid JSON. Check the interface source address.'); }
    const manifest = validateManifest(metadata);
    const current = manifest.revision === active.manifest.revision;
    set(current ? 'current' : 'available', current ? 'The interface matches the trusted server.' :
      'A new interface is available. Save work in your open views, then refresh.', { availableRevision: current ? undefined : manifest.revision });
    return manifest;
  }
  async function stage(manifest, transfer) {
    const destination = join(releases, manifest.revision);
    try {
      const cached = await localRelease(destination);
      if (cached.manifest.revision === manifest.revision) return { release: cached, downloadedBytes: 0 };
    }
    catch { /* Incomplete cached candidates must be checked and staged again. */ }
    const directory = await mkdtemp(join(cacheRoot, '.stage-'));
    let downloadedBytes = 0;
    try {
      const reusable = [active, bundle].flatMap(release => release.manifest.files.map(file => ({ ...file, root: release.root })));
      for (const file of manifest.files) {
        let bytes;
        for (const candidate of reusable.filter(other => other.sha256 === file.sha256 && other.bytes === file.bytes)) {
          try {
            const cached = await localBytes(join(candidate.root, candidate.path), file.bytes);
            if (cached.length === file.bytes && digest(cached) === file.sha256) { bytes = cached; break; }
          } catch { /* A damaged local asset can still be fetched from the trusted source. */ }
        }
        if (!bytes) {
          bytes = await fetchBytes(file.path, file.bytes, transfer, file.sha256);
          downloadedBytes += bytes.length;
        }
        const path = join(directory, file.path);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, bytes, { mode: 0o600 });
      }
      await atomicJson(join(directory, MANIFEST), manifest);
      await rm(destination, { recursive: true, force: true });
      await rename(directory, destination);
      return { release: { root: destination, manifest }, downloadedBytes };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  function load(target, previous, persist, resultMessage, resultStatus = 'current', downloadedBytes = 0) {
    clearTimeout(timer); token = randomUUID(); active = target;
    const activation = { token, previous, persist, resultMessage, resultStatus, downloadedBytes, target };
    pending = activation;
    set('loading', 'Opening the verified interface...', { downloadedBytes });
    timer = setTimeout(() => { void loadFailed(); }, readyTimeoutMs); timer.unref?.();
    // Navigation must not hold the transition lock: the new document uses it to acknowledge readiness.
    try { void Promise.resolve(reload()).catch(() => { if (pending === activation) void loadFailed(); }); }
    catch { void loadFailed(); }
    return getState();
  }
  function loadFailed() {
    const failed = pending; const target = active;
    return serialize(async () => {
      if (disposed || active !== target) return getState();
      clearTimeout(timer); pending = undefined;
      if (active === bundle) {
        set('error', 'The bundled interface could not start. Reopen the app or replace the AppImage from GitHub Releases.');
        return getState();
      }
      const previous = failed?.previous ?? fallback;
      const good = previous === bundle ? null : previous.manifest.revision;
      try { if (cacheAvailable && config.good !== good) await save({ ...config, good, previous: null }); }
      catch { cacheAvailable = false; }
      return load(previous, bundle, false, 'The new interface could not start. The previous interface was restored.', 'error');
    });
  }
  function ready(documentToken) {
    return serialize(async () => {
      const expected = pending;
      if (!expected || expected.token !== documentToken || disposed) return getState();
      clearTimeout(timer);
      try {
        if (expected.persist && cacheAvailable) {
          const good = expected.target === bundle ? null : expected.target.manifest.revision;
          await save({ ...config, good, previous: good ? config.good : null });
        }
        fallback = expected.previous;
        await clean();
        pending = undefined;
        set(config.source ? expected.resultStatus : 'unconfigured', expected.resultMessage, { downloadedBytes: expected.downloadedBytes });
        if (!cacheAvailable) cacheError();
      } catch {
        // Queue recovery after this transition releases its pointer-write lock.
        void loadFailed();
      }
      return getState();
    });
  }
  async function run(action, value) {
    if (busy || pending || transitions || disposed) return getState();
    if (!cacheAvailable) { cacheError(); return getState(); }
    busy = true;
    const startingToken = token;
    try {
      if (action === 'source') {
        const source = value === '' ? '' : sourceUrl(value).href;
        if (source !== config.source) {
          if (!await confirmSource(source)) return getState();
          await serialize(() => save({ ...config, source }));
        }
      }
      if (pending || token !== startingToken) return getState();
      if (!config.source) {
        set('unconfigured', 'Choose a trusted server for interface updates. The current interface remains available.');
        return getState();
      }
      // A background metadata check shares the busy flag with the manual controls.
      const manual = action === 'refresh';
      const timeoutMs = manual ? 15 * 60_000 : 15_000;
      const transfer = { deadline: AbortSignal.timeout(timeoutMs), attempts: manual ? 3 : 1, timeoutMs };
      set('checking', 'Checking the trusted interface server...');
      const manifest = await probe(transfer);
      if (manual && manifest.revision !== active.manifest.revision) {
        set('loading', 'Fetching changed interface files. The current window stays open until verification finishes.');
        const { release, downloadedBytes } = await stage(manifest, transfer);
        if (token !== startingToken) {
          if (![config.good, config.previous, active.manifest.revision].includes(release.manifest.revision)) await rm(release.root, { recursive: true, force: true });
          return getState();
        }
        return await load(release, active, true, 'The interface was refreshed. The desktop runtime did not change.', 'current', downloadedBytes);
      }
    } catch (error) { set('error', errorMessage(error)); }
    finally { busy = false; }
    return getState();
  }
  return {
    getState, check: () => run('check'), refresh: () => run('refresh'), setSource: value => run('source', value), ready,
    documentToken: () => token,
    start: () => serialize(() => load(active, fallback, false, recovered ? 'A verified recovery interface is open.' : 'The saved interface is ready. Updates wait for your refresh.')),
    loadFailed,
    async restore() {
      if (busy || disposed) return getState();
      return serialize(() => load(bundle, bundle, true, 'The bundled interface is open. Refresh only after the trusted server is ready.'));
    },
    assetPath(path) {
      if (path === 'bootstrap.json') return join(bundleRoot, path);
      if (!assetPath(path) || !active.manifest.files.some(file => file.path === path)) return null;
      return join(active.root, path);
    },
    dispose() { disposed = true; clearTimeout(timer); },
  };
}
function registerInterfaceIpc(ipcMain, window, controller) {
  for (const action of ['getState', 'setSource', 'check', 'refresh', 'restore', 'ready', 'documentToken']) {
    ipcMain.handle(`emachine:interface:${action}`, (event, value) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
          event.senderFrame.url !== 'emachine://app/index.html') throw new Error('Interface access denied');
      return controller[action](value);
    });
  }
}
module.exports = { createInterfaceController, registerInterfaceIpc };
