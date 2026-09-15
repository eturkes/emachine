import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clientSeed } from '../scripts/seed-client.mjs';

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
