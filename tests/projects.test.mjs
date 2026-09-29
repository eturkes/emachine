import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rm, rename, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, socket, until } from './network-helper.mjs';
import { claudeSession } from './claude-helper.mjs';

const exec = promisify(execFile);

test('Claude status follows live sessions without opening terminals or reading transcripts', async t => {
  const f = await fixture(); t.after(() => f.close());
  const events = await socket(f, 'api/v1/events'); t.after(() => events.close());
  const current = () => events.packets.filter(p => p.type === 'inventory').at(-1)?.state.projects.find(p => p.name === 'alpha');
  await until(() => current());
  assert.equal(current().claudeStatus, null);
  for (const [source, expected] of [['busy', 'working'], ['waiting', 'waiting'], ['idle', 'completed'], ['busy', 'working']]) {
    await claudeSession(f, source);
    await until(() => current()?.claudeStatus === expected);
    assert.deepEqual(current().features, []);
    assert.equal((await f.state()).projects.find(p => p.name === 'beta').claudeStatus, null);
  }
  await f.stop(); await f.start();
  assert.equal((await f.state()).projects.find(p => p.name === 'alpha').claudeStatus, 'working');
  await rm(join(f.home, `.claude/sessions/${process.pid}.json`));
  await until(async () => (await f.state()).projects.find(p => p.name === 'alpha').claudeStatus === null);
  assert.equal((await exec('zmx', ['list', '--short'], { env: f.env }).catch(() => ({ stdout: '' }))).stdout.trim(), '');
});

test('Claude status prioritizes waiting, validates process identity, and clears dead sessions', async t => {
  const f = await fixture(); t.after(() => f.close());
  const child = spawn('sleep', ['120']); t.after(() => child.kill());
  const status = async () => JSON.parse(await f.cli('projects')).projects.find(p => p.name === 'alpha').claudeStatus;
  await mkdir(join(f.config.projectRoot, 'alpha/nested'));
  await claudeSession(f, 'busy', { cwd: join(f.config.projectRoot, 'alpha/nested') });
  await claudeSession(f, 'waiting', { pid: child.pid });
  assert.equal(await status(), 'waiting');
  await claudeSession(f, 'idle', { pid: child.pid });
  assert.equal(await status(), 'working');
  await claudeSession(f, 'idle');
  assert.equal(await status(), 'completed');
  const { path, record } = await claudeSession(f, 'waiting', { pid: child.pid });
  await writeFile(path, JSON.stringify({ ...record, procStart: '0' }));
  assert.equal(await status(), 'completed');
  await writeFile(path, JSON.stringify({ ...record, pidDomain: 'linux:another-host:pid:[1]' }));
  assert.equal(await status(), 'completed');
  await writeFile(path, JSON.stringify(record));
  await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
  assert.equal(await status(), 'completed');
  await rm(join(f.home, `.claude/sessions/${process.pid}.json`));
  assert.equal(await status(), null);
});

test('Claude metadata is bounded, optional, isolated, and never exposes session contents', async t => {
  const f = await fixture(); t.after(() => f.close());
  const current = async () => JSON.parse(await f.cli('projects')).projects.find(p => p.name === 'alpha');
  const { path, record } = await claudeSession(f, 'busy');
  for (const change of [
    { status: 'unknown' }, { procStart: '' }, { pid: 1.5 }, { pid: 1 },
    { procStart: record.procStart + '\u0000ignored' }, { pidDomain: record.pidDomain + '\u0000ignored' },
    { kind: 'daemon' }, { kind: 'bg' }, { sessionId: '' },
    { cwd: join(f.config.projectRoot, 'alpha-other') },
  ]) {
    await writeFile(path, JSON.stringify({ ...record, ...change }));
    assert.equal((await current()).claudeStatus, null, JSON.stringify(change));
  }
  for (const text of ['{', 'x'.repeat(65537), Buffer.from([255])]) {
    await writeFile(path, text);
    assert.equal((await current()).claudeStatus, null);
  }
  await writeFile(path, JSON.stringify({ ...record, waitingFor: 'PRIVATE INPUT', peerToken: 'PRIVATE TOKEN' }));
  const project = await current();
  assert.equal(project.claudeStatus, 'working');
  assert.doesNotMatch(JSON.stringify(project), /PRIVATE|peerToken|sessionId|procStart/);
  const outside = join(f.home, 'outside-session.json');
  await rename(path, outside); await symlink(outside, path);
  assert.equal((await current()).claudeStatus, null);
  await rm(path); await mkdir(path);
  assert.equal((await current()).claudeStatus, null);
});

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
