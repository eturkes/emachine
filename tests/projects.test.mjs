import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rm, rename, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, socket, until } from './network-helper.mjs';

const exec = promisify(execFile);

test('discovery excludes filesystem snapshots, including cached identities', async t => {
  const f = await fixture(); t.after(() => f.close());
  const root = f.config.projectRoot;
  await mkdir(join(root, 'ordinary'));
  const prior = JSON.parse(await f.cli('projects')).projects.find(p => p.name === 'ordinary');
  await rename(join(root, 'ordinary'), join(root, '.snapshots'));
  await mkdir(join(root, '.visible'));
  await mkdir(join(root, 'alpha/nested'));
  const result = JSON.parse(await f.cli('projects'));
  assert.deepEqual(result.projects.map(p => p.name).sort(), ['.visible', 'alpha', 'beta']);
  await assert.rejects(f.cli('diagnostics', prior.id));
  await assert.rejects(f.cli('diagnostics', '.snapshots'));
  await until(async () => !(await f.state()).projects.some(p => p.id === prior.id));
});

test('phases follow root CLAUDE.md and current worktree bytes, not project names', async t => {
  const f = await fixture(); t.after(() => f.close());
  const root = f.config.projectRoot;
  for (const name of ['alpha', 'beta', 'trading']) {
    await mkdir(join(root, name, '.agent'), { recursive: true });
    await writeFile(join(root, name, '.agent/spec.md'), '## Phase\nITERATE. IMPLEMENT is suspended.\n');
  }
  await writeFile(join(root, 'alpha/CLAUDE.md'), '@.agent/spec.md\n');
  await writeFile(join(root, 'trading/CLAUDE.md'), '@.agent/spec.md\n');
  await mkdir(join(root, 'beta/nested'));
  await writeFile(join(root, 'beta/nested/CLAUDE.md'), 'Not the project root.\n');
  await exec('git', ['init', '-q'], { cwd: join(root, 'alpha') });
  await writeFile(join(root, 'alpha/.agent/spec.md'), 'Phase: PROTOTYPE\n');
  await exec('git', ['add', '.'], { cwd: join(root, 'alpha') });
  const spec = '## Phase\nITERATE. IMPLEMENT is suspended.\n';
  await writeFile(join(root, 'alpha/.agent/spec.md'), spec);
  const state = JSON.parse(await f.cli('projects'));
  assert.equal(state.projects.find(p => p.name === 'alpha').phase, 'ITERATE');
  assert.equal(state.projects.find(p => p.name === 'trading').phase, 'ITERATE');
  assert.equal(state.projects.find(p => p.name === 'beta').phase, null);
  assert.equal(await readFile(join(root, 'alpha/.agent/spec.md'), 'utf8'), spec);
  assert.match((await exec('git', ['diff', '--', '.agent/spec.md'], { cwd: join(root, 'alpha') })).stdout, /\+ITERATE/);
  await mkdir(join(root, 'beta/CLAUDE.md'));
  assert.equal(JSON.parse(await f.cli('projects')).projects.find(p => p.name === 'beta').phase, null);
});

test('phase changes and eligibility changes reach inventory events without features', async t => {
  const f = await fixture(); t.after(() => f.close());
  const root = join(f.config.projectRoot, 'alpha');
  await mkdir(join(root, '.agent'));
  const events = await socket(f, 'api/v1/events'); t.after(() => events.close());
  const current = () => events.packets.filter(p => p.type === 'inventory').at(-1)?.state.projects.find(p => p.name === 'alpha');
  await writeFile(join(root, 'CLAUDE.md'), '@.agent/spec.md\n');
  for (const phase of ['PROTOTYPE', 'ITERATE', 'IMPLEMENT', 'MAINTAIN', 'ITERATE']) {
    await writeFile(join(root, '.agent/spec.md'), `## Phase\n${phase}\n`);
    await until(() => current()?.phase === phase);
    assert.deepEqual(current().features, []);
  }
  await rm(join(root, '.agent/spec.md'));
  await until(() => current()?.phase === 'UNKNOWN');
  await rm(join(root, 'CLAUDE.md'));
  await until(() => current()?.phase === null);
});

test('unavailable or invalid phase sources stay unknown without failing discovery', async t => {
  const f = await fixture(); t.after(() => f.close());
  const root = join(f.config.projectRoot, 'alpha');
  await mkdir(join(root, '.agent'));
  await writeFile(join(root, 'CLAUDE.md'), '@.agent/spec.md\n');
  const phase = async () => JSON.parse(await f.cli('projects')).projects.find(p => p.name === 'alpha').phase;
  assert.equal(await phase(), 'UNKNOWN');
  for (const spec of ['## Phase\nRESEARCH\n', 'Phase: ITERATE\nPhase: IMPLEMENT\n', 'x'.repeat(1048577), Buffer.from([255])]) {
    await writeFile(join(root, '.agent/spec.md'), spec);
    assert.equal(await phase(), 'UNKNOWN');
  }
  await rm(join(root, '.agent/spec.md'));
  await mkdir(join(root, '.agent/spec.md'));
  assert.equal(await phase(), 'UNKNOWN');
  await rm(join(root, '.agent/spec.md'), { recursive: true });
  const outside = join(f.home, 'outside-spec.md');
  await writeFile(outside, 'Phase: MAINTAIN\n');
  await symlink(outside, join(root, '.agent/spec.md'));
  assert.equal(await phase(), 'UNKNOWN');
});
