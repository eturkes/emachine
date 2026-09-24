'use strict';
const { mkdirSync, readdirSync, lstatSync, realpathSync, renameSync, cpSync, rmSync, mkdtempSync, writeFileSync } = require('node:fs');
const { join, isAbsolute } = require('node:path');

// The legacy desktop profile shares its directory with server configuration.
// Move only desktop-owned entries; keep server files and the singleton lock there.
const runtimeEntries = new Set([
  'blob_storage', 'Cache', 'Code Cache', 'GPUCache', 'GrShaderCache', 'ShaderCache',
  'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Dictionaries', 'VideoDecodeStats',
  'Local Storage', 'Session Storage', 'IndexedDB', 'databases', 'File System',
  'Service Worker', 'CacheStorage', 'WebStorage', 'SharedStorage', 'Shared Dictionary',
  'Shared Proto DB', 'Network', 'Network Persistent State', 'TransportSecurity',
  'Cookies', 'Trust Tokens', 'DIPS', 'QuotaManager', 'Reporting and NEL',
  'Preferences', 'Local State', 'Partitions', 'Crashpad', 'logs', 'interface',
  'DevToolsActivePort', 'declarative_performance_observer.db',
]);
const migrated = '.desktop-cache-v1';

function move(source, destination, cacheRoot) {
  try { renameSync(source, destination); }
  catch (error) {
    if (error.code !== 'EXDEV') throw error;
    // Publish a complete copy before removing the source on another filesystem.
    const stage = mkdtempSync(join(cacheRoot, '.migrate-'));
    try {
      const copy = join(stage, 'entry');
      cpSync(source, copy, { recursive: true, dereference: false, preserveTimestamps: true, force: false, errorOnExist: true });
      renameSync(copy, destination);
      rmSync(source, { recursive: true });
    } finally { rmSync(stage, { recursive: true, force: true }); }
  }
}

function migrate(profile, cacheRoot) {
  if (realpathSync(profile) === realpathSync(cacheRoot)) return;
  const names = readdirSync(profile);
  // Keep the marker outside the cache so clearing it never restores stale databases.
  if (names.includes(migrated)) return;
  const entries = names.filter(name => runtimeEntries.has(name) || runtimeEntries.has(name.replace(/-(journal|wal|shm)$/, '')));
  const existing = new Set(readdirSync(cacheRoot));
  if (entries.length && existing.has('SingletonLock')) throw new Error('Close the client that uses the cache directory before migrating desktop storage.');
  for (const name of entries) {
    if (existing.has(name)) throw new Error(`Desktop storage already exists in both locations: ${name}. Preserve both copies before resolving this conflict.`);
    const info = lstatSync(join(profile, name));
    if (!info.isFile() && !info.isDirectory()) throw new Error(`Desktop storage must be a regular file or directory: ${name}.`);
  }
  for (const name of entries) move(join(profile, name), join(cacheRoot, name), cacheRoot);
  writeFileSync(join(profile, migrated), '1\n', { mode: 0o600, flag: 'wx' });
}

function configureDesktopStorage(app) {
  if (process.platform !== 'linux' || !app.isPackaged || app.commandLine.hasSwitch('user-data-dir')) return;
  const xdg = process.env.XDG_CACHE_HOME;
  const cacheRoot = join(xdg && isAbsolute(xdg) ? xdg : join(app.getPath('home'), '.cache'), 'emachine');
  mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  // The caller owns the legacy profile's single-instance lock, before Electron ready.
  migrate(app.getPath('userData'), cacheRoot);
  // Chromium also writes runtime files outside Session's storage directory.
  app.setPath('userData', cacheRoot);
  app.setPath('sessionData', cacheRoot);
  for (const [name, directory] of [['crashDumps', 'Crashpad'], ['logs', 'logs']]) {
    const path = join(cacheRoot, directory);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    if (name === 'logs') app.setAppLogsPath(path); else app.setPath(name, path);
  }
}

module.exports = { configureDesktopStorage };
