import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clientSeed } from '../scripts/seed-client.mjs';
import { updateManifest, validateUpdateMetadata } from '../scripts/update-metadata.mjs';

test('desktop releases use the public GitHub update feed', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(pkg.build.publish, [{ provider: 'github', owner: 'eturkes', repo: 'emachine', releaseType: 'release' }]);
  assert.ok(pkg.dependencies['electron-updater']);
});

test('update metadata binds the version, asset filename, size and checksum', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'emachine-update-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const name = 'emachine-1.2.3-x86_64.AppImage';
  const bytes = Buffer.from('AppImage fixture bytes');
  const sha512 = createHash('sha512').update(bytes).digest('base64');
  await writeFile(join(directory, name), bytes);
  const valid = { version: '1.2.3', files: [{ url: name, size: bytes.length, sha512 }], path: name, sha512 };
  await assert.rejects(validateUpdateMetadata(directory, '1.2.3', name), /ENOENT/);
  await writeFile(join(directory, updateManifest), JSON.stringify(valid));
  assert.deepEqual(await validateUpdateMetadata(directory, '1.2.3', name), valid);
  for (const mutate of [m => { m.version = '1.2.2'; }, m => { m.files = []; },
    m => { m.files[0].url = 'https://other.invalid/file.AppImage'; }, m => { m.path = '../escape.AppImage'; },
    m => { m.files[0].size++; }, m => { m.files[0].sha512 = 'incorrect'; }, m => { m.sha512 = 'incorrect'; }]) {
    const invalid = structuredClone(valid); mutate(invalid);
    await writeFile(join(directory, updateManifest), JSON.stringify(invalid));
    await assert.rejects(validateUpdateMetadata(directory, '1.2.3', name));
  }
});

test('release seeds are empty even when the local configuration is unreadable', async t => {
  const home = await mkdtemp(join(tmpdir(), 'emachine-release-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const configPath = join(home, 'config.json');
  await writeFile(configPath, 'invalid private configuration');
  assert.deepEqual(await clientSeed({ mode: 'empty', home, configPath }), { servers: [] });
});

test('local seeds whitelist connection metadata and exclude credentials', async t => {
  const home = await mkdtemp(join(tmpdir(), 'emachine-release-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const stateRoot = join(home, 'state');
  await mkdir(stateRoot);
  await writeFile(join(stateRoot, 'machine.json'), JSON.stringify({ id: 'test-machine' }));
  const configPath = join(home, 'config.json');
  await writeFile(configPath, JSON.stringify({ stateRoot, machineName: 'Workstation',
    directUrl: 'https://workstation.invalid/', gatewayUrl: 'https://gateway.invalid/m/workstation/',
    gatewaySecret: 'fixture-secret', allowedUsers: ['private@example.invalid'], projectRoot: '/private/projects' }));
  assert.deepEqual(await clientSeed({ mode: 'local', home, configPath }), { servers: [{
    id: 'test-machine', name: 'Workstation', direct: 'https://workstation.invalid/',
    gateway: 'https://gateway.invalid/m/workstation/',
  }] });
});

test('missing local configuration produces an empty seed; invalid modes fail closed', async t => {
  const home = await mkdtemp(join(tmpdir(), 'emachine-release-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const configPath = join(home, 'absent.json');
  assert.deepEqual(await clientSeed({ mode: 'local', home, configPath }), { servers: [] });
  await assert.rejects(clientSeed({ mode: 'empti', home, configPath }), /seed mode/i);
});
