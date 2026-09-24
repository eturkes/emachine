import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, existsSync, writeFileSync, readdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const mainPath = fileURLToPath(new URL('../desktop/main.cjs', import.meta.url));
const require = createRequire(mainPath);
function fixture(t, { cacheHome, explicit = false, packaged = true, locked = true, cacheLocked = true, platform = 'linux', crossDevice = false, failCopy = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'emachine-storage-unit-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const config = join(home, '.config/emachine');
  mkdirSync(config, { recursive: true });
  const paths = { home, userData: config, sessionData: config };
  const calls = [], errors = [], lockRoots = [];
  const app = { isPackaged: packaged, commandLine: { hasSwitch: key => key === 'user-data-dir' && explicit },
    getPath: key => paths[key], setPath: (key, value) => { assert.ok(existsSync(value)); calls.push(key); paths[key] = value; },
    setAppLogsPath: value => { calls.push('logs'); paths.logs = value; }, setName() {}, on() {},
    requestSingleInstanceLock: () => { calls.push('lock'); lockRoots.push(paths.userData); return paths.userData === config ? locked : cacheLocked; },
    releaseSingleInstanceLock: () => calls.push('unlock'), quit: () => calls.push('quit'),
    exit: code => { calls.push('quit'); calls.push('exit:' + code); },
    whenReady: () => { calls.push('ready'); return { then: () => ({ catch() {} }) }; },
  };
  const electron = { app, protocol: { registerSchemesAsPrivileged() {} }, dialog: { showErrorBox: (...args) => errors.push(args) } };
  const env = { HOME: home, ...(cacheHome === undefined ? {} : { XDG_CACHE_HOME: cacheHome === 'custom' ? join(home, 'custom-cache') : cacheHome }) };
  const storageRequire = name => {
    const value = require(name);
    if (name !== 'node:fs' || !crossDevice) return value;
    return { ...value, renameSync: (source, destination) => {
      if (source.startsWith(config + '/')) throw Object.assign(new Error('cross-device fixture'), { code: 'EXDEV' });
      return value.renameSync(source, destination);
    }, cpSync: (source, destination, options) => {
      if (failCopy) {
        mkdirSync(destination); writeFileSync(join(destination, 'partial'), 'incomplete');
        throw Object.assign(new Error('full disk fixture'), { code: 'ENOSPC' });
      }
      return value.cpSync(source, destination, options);
    } };
  };
  const start = () => {
    paths.userData = config; paths.sessionData = config;
    return runInNewContext(readFileSync(mainPath, 'utf8'), {
    require: name => {
      if (name === 'electron') return electron;
      // Load storage code with the fixture's environment, not the real account's paths.
      if (name === './storage.cjs') {
        const module = { exports: {} };
        runInNewContext(readFileSync(new URL('../desktop/storage.cjs', import.meta.url), 'utf8'),
          { require: storageRequire, module, process: { env, platform }, console });
        return module.exports;
      }
      return require(name);
    },
    process: { env, platform }, console: { error: error => errors.push(String(error)) },
    });
  };
  return { home, config, paths, calls, errors, lockRoots, start, cache: join(env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.startsWith('/') ? env.XDG_CACHE_HOME : join(home, '.cache'), 'emachine') };
}

for (const cacheHome of [undefined, '', 'custom', 'relative/cache']) {
  test(`packaged Linux redirects storage before ready (${cacheHome ?? 'default'})`, t => {
    const f = fixture(t, { cacheHome }); f.start();
    assert.equal(f.paths.sessionData, f.cache, 'Browser databases and caches must leave the configuration directory.');
    assert.equal(f.paths.userData, f.cache);
    assert.deepEqual(f.lockRoots, [f.config, f.cache], 'Migration locks the legacy profile; Chromium must then own its runtime profile lock.');
    assert.equal(f.paths.crashDumps, join(f.cache, 'Crashpad'));
    assert.equal(f.paths.logs, join(f.cache, 'logs'));
    assert.ok(f.calls.indexOf('lock') < f.calls.indexOf('sessionData'));
    assert.ok(f.calls.indexOf('sessionData') < f.calls.indexOf('ready'));
    assert.equal(statSync(f.cache).mode & 0o777, 0o700);
    assert.deepEqual(f.errors, []);
  });
}

for (const options of [{ explicit: true }, { packaged: false }, { platform: 'darwin' }, { locked: false }]) {
  test(`preserves explicit/development profiles and lock ownership ${JSON.stringify(options)}`, t => {
    const f = fixture(t, options); f.start();
    assert.equal(f.paths.sessionData, f.config);
    assert.equal(existsSync(f.cache), false);
    assert.equal(f.calls.includes('ready'), options.locked !== false);
    if (options.locked === false) assert.ok(f.calls.includes('exit:0'));
  });
}

test('moves desktop databases and interface state without touching server or unknown configuration', t => {
  const f = fixture(t);
  for (const name of ['Local Storage', 'IndexedDB', 'GPUCache', 'interface']) {
    mkdirSync(join(f.config, name)); writeFileSync(join(f.config, name, 'fixture'), name);
  }
  const databases = ['Cookies', 'Cookies-journal', 'Preferences', 'Local State', 'declarative_performance_observer.db', 'declarative_performance_observer.db-journal'];
  for (const name of databases) writeFileSync(join(f.config, name), name);
  for (const name of ['config.json', 'custom.json']) writeFileSync(join(f.config, name), name);
  mkdirSync(join(f.config, 'phone')); writeFileSync(join(f.config, 'phone/password'), 'fixture-secret');
  f.start();
  assert.equal(f.paths.sessionData, f.cache);
  for (const name of ['Local Storage', 'IndexedDB', 'GPUCache', 'interface']) {
    assert.equal(readFileSync(join(f.cache, name, 'fixture'), 'utf8'), name);
    assert.equal(existsSync(join(f.config, name)), false);
  }
  for (const name of databases) assert.equal(readFileSync(join(f.cache, name), 'utf8'), name);
  for (const name of ['config.json', 'custom.json']) assert.equal(readFileSync(join(f.config, name), 'utf8'), name);
  assert.equal(readFileSync(join(f.config, 'phone/password'), 'utf8'), 'fixture-secret');
  assert.equal(existsSync(join(f.cache, 'phone')), false);
  assert.deepEqual(f.errors, []);
});

test('repeated startup does not overwrite current databases or resurrect legacy state after cache deletion', t => {
  const f = fixture(t); writeFileSync(join(f.config, 'Cookies'), 'legacy'); f.start();
  assert.equal(readFileSync(join(f.cache, 'Cookies'), 'utf8'), 'legacy');
  writeFileSync(join(f.cache, 'Cookies'), 'current');
  writeFileSync(join(f.config, 'Cookies'), 'downgraded-client');
  f.start(); assert.equal(readFileSync(join(f.cache, 'Cookies'), 'utf8'), 'current');
  rmSync(f.cache, { recursive: true }); f.start();
  assert.equal(existsSync(join(f.cache, 'Cookies')), false);
});

test('conflicting migration fails before moving anything or starting Chromium', t => {
  const f = fixture(t); mkdirSync(f.cache, { recursive: true });
  writeFileSync(join(f.config, 'Cookies'), 'legacy'); writeFileSync(join(f.cache, 'Cookies'), 'current');
  mkdirSync(join(f.config, 'Local Storage')); writeFileSync(join(f.config, 'Local Storage/fixture'), 'keep');
  f.start();
  assert.ok(f.calls.includes('quit')); assert.equal(f.calls.includes('ready'), false);
  assert.equal(readFileSync(join(f.config, 'Cookies'), 'utf8'), 'legacy');
  assert.equal(readFileSync(join(f.cache, 'Cookies'), 'utf8'), 'current');
  assert.equal(readFileSync(join(f.config, 'Local Storage/fixture'), 'utf8'), 'keep');
  assert.ok(f.errors.length);
});

test('unwritable cache target fails closed instead of writing browser data into configuration', t => {
  const f = fixture(t); mkdirSync(join(f.home, '.cache')); writeFileSync(f.cache, 'not a directory');
  f.start(); assert.ok(f.calls.includes('quit')); assert.equal(f.calls.includes('ready'), false);
  assert.deepEqual(readdirSync(f.config), []);
});

test('a cache root that resolves to the existing profile does not migrate onto itself', t => {
  const f = fixture(t); mkdirSync(join(f.home, '.cache')); symlinkSync(f.config, f.cache);
  writeFileSync(join(f.config, 'Cookies'), 'existing'); f.start();
  assert.equal(readFileSync(join(f.config, 'Cookies'), 'utf8'), 'existing');
  assert.ok(f.calls.includes('ready')); assert.deepEqual(f.errors, []);
});

test('cross-device migration publishes complete copies and removes staging files', t => {
  const f = fixture(t, { crossDevice: true });
  mkdirSync(join(f.config, 'Local Storage')); writeFileSync(join(f.config, 'Local Storage/fixture'), 'database');
  writeFileSync(join(f.config, 'Cookies'), 'cookies'); f.start();
  assert.equal(readFileSync(join(f.cache, 'Local Storage/fixture'), 'utf8'), 'database');
  assert.equal(readFileSync(join(f.cache, 'Cookies'), 'utf8'), 'cookies');
  assert.equal(existsSync(join(f.config, 'Local Storage')), false);
  assert.equal(existsSync(join(f.config, 'Cookies')), false);
  assert.equal(readdirSync(f.cache).some(name => name.startsWith('.migrate-')), false);
  assert.deepEqual(f.errors, []);
});

test('failed cross-device copying preserves the source and never publishes partial databases', t => {
  const f = fixture(t, { crossDevice: true, failCopy: true });
  mkdirSync(join(f.config, 'Local Storage')); writeFileSync(join(f.config, 'Local Storage/fixture'), 'database');
  f.start(); assert.ok(f.calls.includes('quit')); assert.equal(f.calls.includes('ready'), false);
  assert.equal(readFileSync(join(f.config, 'Local Storage/fixture'), 'utf8'), 'database');
  assert.deepEqual(readdirSync(f.cache), []);
  assert.equal(existsSync(join(f.config, '.desktop-cache-v1')), false);
});

test('an interrupted migration resumes without replacing entries that already moved', t => {
  const f = fixture(t); mkdirSync(f.cache, { recursive: true });
  writeFileSync(join(f.cache, 'Cookies'), 'already moved');
  mkdirSync(join(f.config, 'Local Storage')); writeFileSync(join(f.config, 'Local Storage/fixture'), 'remaining');
  f.start();
  assert.equal(readFileSync(join(f.cache, 'Cookies'), 'utf8'), 'already moved');
  assert.equal(readFileSync(join(f.cache, 'Local Storage/fixture'), 'utf8'), 'remaining');
  assert.deepEqual(f.errors, []);
});

test('migration does not follow desktop-entry symlinks', t => {
  const f = fixture(t); const original = join(f.home, 'original');
  writeFileSync(original, 'keep'); symlinkSync(original, join(f.config, 'Cookies')); f.start();
  assert.ok(f.calls.includes('quit')); assert.equal(f.calls.includes('ready'), false);
  assert.equal(readFileSync(original, 'utf8'), 'keep');
  assert.equal(existsSync(join(f.cache, 'Cookies')), false);
});

test('an already running cache profile receives the second launch without another Chromium session', t => {
  const f = fixture(t, { cacheLocked: false }); f.start();
  assert.ok(f.calls.includes('exit:0')); assert.equal(f.calls.includes('ready'), false);
});

test('legacy data does not move into a cache profile with an existing singleton lock', t => {
  const f = fixture(t); mkdirSync(f.cache, { recursive: true });
  writeFileSync(join(f.cache, 'SingletonLock'), 'active profile fixture');
  writeFileSync(join(f.config, 'Cookies'), 'legacy'); f.start();
  assert.ok(f.calls.includes('exit:1')); assert.equal(f.calls.includes('ready'), false);
  assert.equal(readFileSync(join(f.config, 'Cookies'), 'utf8'), 'legacy');
  assert.equal(existsSync(join(f.cache, 'Cookies')), false);
});
