import { test } from 'node:test';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rm, rename, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, socket, until } from './network-helper.mjs';
import { claudeSession } from './claude-helper.mjs';

const exec = promisify(execFile);

test('Claude keeper activity refines idle registry sessions without inventing activity', async t => {
  let body;
  const requests = [];
  const keeper = createServer((req, res) => {
    requests.push([req.method, req.url]);
    if (body === undefined) return; // Exercise a keeper that accepts but never replies.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
  });
  await new Promise((resolve, reject) => {
    keeper.once('error', reject);
    keeper.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => keeper.close(resolve)));
  const f = await fixture({ keeperUrl: `http://127.0.0.1:${keeper.address().port}` });
  t.after(() => f.close());
  await f.stop(); // Each CLI inventory below should make at most one request.
  const project = join(f.config.projectRoot, 'alpha');
  const alias = join(f.home, 'alias');
  await symlink(project, alias);
  const sessionId = 'aaaaaaaa-1111-4111-8111-111111111111';
  const register = (status, options = {}) => claudeSession(f, status, { sessionId, cwd: alias, ...options });
  const state = async () => JSON.parse(await f.cli('projects'));
  const badge = async () => (await state()).projects.find(p => p.name === 'alpha').claudeStatus;
  const entry = { session: sessionId.slice(0, 8), dir: project, state: 'armed', working: true };
  const report = (...entries) => { body = JSON.stringify({ interval: 3300, touches: 19, entries }); };

  await register('idle');
  report(entry);
  assert.equal(await badge(), 'working', 'a running turn can outlive the registry busy signal');
  assert.deepEqual(requests, [['GET', '/_keepalive']]);
  for (const [change, expected] of [
    [{ state: 'ready' }, 'working'], [{ state: 'compacting', working: false }, 'working'],
    [{ working: false, mark: 'touch' }, 'completed'], [{ working: 'true' }, 'completed'],
    [{ state: 'done', working: false }, 'completed'], [{ state: 'lapsed', working: false }, 'completed'],
    [{ state: 'compacted', working: false }, 'completed'], [{ state: 'unexpected' }, 'completed'],
    [{ state: 'done' }, 'working'], [{ state: 'lapsed' }, 'working'], [{ state: 'compacted' }, 'working'],
    [{ session: 'bbbbbbbb' }, 'completed'], [{ dir: f.home }, 'completed'],
  ]) {
    report({ ...entry, ...change });
    assert.equal(await badge(), expected, JSON.stringify(change));
  }
  report(entry, { ...entry, working: false });
  assert.equal(await badge(), 'completed', 'ambiguous keeper rows');
  for (const invalid of [undefined, '{', JSON.stringify({ entries: {} }),
    JSON.stringify({ entries: [entry], padding: 'x'.repeat(262144) })]) {
    body = invalid;
    assert.equal(await badge(), 'completed');
  }
  report(entry);
  await register('waiting');
  assert.equal(await badge(), 'waiting');
  report({ ...entry, working: false, mark: 'compact' });
  await register('shell');
  assert.equal(await badge(), 'working');

  const child = spawn('sleep', ['120']);
  t.after(() => child.kill());
  await register('idle');
  await register('idle', { pid: child.pid, sessionId: 'aaaaaaaa-2222-4222-8222-222222222222' });
  report(entry);
  requests.length = 0;
  assert.equal(await badge(), 'completed', 'ambiguous live session prefixes');
  assert.deepEqual(requests, [['GET', '/_keepalive']], 'one request covers both live sessions');
  await rm(join(f.home, `.claude/sessions/${child.pid}.json`));
  await register('idle', { cwd: f.home });
  report({ ...entry, dir: f.home });
  assert.equal((await state()).machine.claudeStatus, 'working');
  await rm(join(f.home, `.claude/sessions/${process.pid}.json`));
  assert.equal((await state()).machine.claudeStatus ?? null, null, 'a keeper entry alone cannot create a session');
  await register('idle');
  report({ ...entry, dir: alias });
  await f.start();
  const events = await socket(f, 'api/v1/events'); t.after(() => events.close());
  const latest = () => events.packets.filter(p => p.type === 'inventory').at(-1)?.state.projects.find(p => p.name === 'alpha');
  await until(() => latest()?.claudeStatus === 'working');
  await new Promise(resolve => keeper.close(resolve));
  await until(() => latest()?.claudeStatus === 'completed');
});

test('machine Claude status follows only live sessions outside discovered projects', async t => {
  const f = await fixture(); t.after(() => f.close());
  const child = spawn('sleep', ['120']); t.after(() => child.kill());
  const inventory = async () => JSON.parse(await f.cli('projects'));
  const project = join(f.config.projectRoot, 'alpha');
  const alias = join(f.home, 'project-alias');
  await mkdir(join(project, 'nested'));
  await symlink(join(project, 'nested'), alias);
  await claudeSession(f, 'waiting', { pid: child.pid, cwd: alias });
  let state = await inventory();
  assert.equal(state.projects.find(p => p.name === 'alpha').claudeStatus, 'waiting');
  assert.equal(state.machine.claudeStatus ?? null, null);
  const session = await claudeSession(f, 'idle', { cwd: f.home });
  assert.equal((await inventory()).machine.claudeStatus, 'completed');
  await claudeSession(f, 'shell', { pid: child.pid, cwd: f.home });
  assert.equal((await inventory()).machine.claudeStatus, 'working');
  await claudeSession(f, 'waiting', { cwd: f.home });
  assert.equal((await inventory()).machine.claudeStatus, 'waiting');
  await rename(f.config.projectRoot, join(f.home, 'former-projects'));
  state = await inventory();
  assert.deepEqual(state.projects, []);
  assert.equal(state.machine.claudeStatus, 'waiting');
  const events = await socket(f, 'api/v1/events'); t.after(() => events.close());
  const latest = () => events.packets.filter(p => p.type === 'inventory').at(-1)?.state;
  await until(() => latest()?.machine.claudeStatus === 'waiting');
  await rm(session.path);
  await until(() => latest()?.machine.claudeStatus === 'working');
  await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
  await until(() => latest() && latest().machine.claudeStatus == null);
  assert.equal((await f.state()).machine.claudeStatus ?? null, null);
});

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

test('Claude shell waits stay working across inventory, restarts, and session precedence', async t => {
  const f = await fixture(); t.after(() => f.close());
  const child = spawn('sleep', ['120']); t.after(() => child.kill());
  const events = await socket(f, 'api/v1/events'); t.after(() => events.close());
  const status = async () => JSON.parse(await f.cli('projects')).projects.find(p => p.name === 'alpha').claudeStatus;
  await claudeSession(f, 'idle');
  await claudeSession(f, 'shell', { pid: child.pid, updatedAt: 1, statusUpdatedAt: 1 });
  assert.equal(await status(), 'working');
  await until(() => events.packets.filter(p => p.type === 'inventory').at(-1)?.state.projects.find(p => p.name === 'alpha').claudeStatus === 'working');
  assert.equal((await f.state()).projects.find(p => p.name === 'alpha').claudeStatus, 'working');
  await f.stop(); await f.start();
  assert.equal((await f.state()).projects.find(p => p.name === 'alpha').claudeStatus, 'working');
  await claudeSession(f, 'waiting');
  assert.equal(await status(), 'waiting');
  await claudeSession(f, 'idle');
  assert.equal(await status(), 'working');
  await claudeSession(f, 'idle', { pid: child.pid });
  assert.equal(await status(), 'completed');
  await claudeSession(f, 'shell', { pid: child.pid });
  assert.equal(await status(), 'working');
  await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
  assert.equal(await status(), 'completed');
  await rm(join(f.home, `.claude/sessions/${process.pid}.json`));
  assert.equal(await status(), null);
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

test('discovery excludes .pnpm-store, including cached identities, without hiding other directories', async t => {
  const f = await fixture(); t.after(() => f.close());
  const root = f.config.projectRoot;
  for (const name of ['ordinary', '.visible', '.pnpm-store-backup', 'pnpm-store']) await mkdir(join(root, name));
  const prior = JSON.parse(await f.cli('projects')).projects.find(p => p.name === 'ordinary');
  const events = await socket(f, 'api/v1/events'); t.after(() => events.close());
  const current = () => events.packets.filter(p => p.type === 'inventory').at(-1)?.state;
  await until(() => current()?.projects.some(p => p.id === prior.id));
  await rename(join(root, 'ordinary'), join(root, '.pnpm-store'));
  const expected = ['.pnpm-store-backup', '.visible', 'alpha', 'beta', 'pnpm-store'];
  assert.deepEqual(JSON.parse(await f.cli('projects')).projects.map(p => p.name).sort(), expected);
  for (const target of [prior.id, '.pnpm-store', join(root, '.pnpm-store')]) await assert.rejects(f.cli('diagnostics', target));
  await until(() => current() && !current().projects.some(p => p.id === prior.id));
  assert.deepEqual((await f.state()).projects.map(p => p.name).sort(), expected);
  await rename(join(root, '.pnpm-store'), join(root, 'ordinary'));
  assert.equal(JSON.parse(await f.cli('projects')).projects.find(p => p.name === 'ordinary').id, prior.id);
  await mkdir(join(root, '.pnpm-store'));
  assert.deepEqual(JSON.parse(await f.cli('projects')).projects.map(p => p.name).sort(), [...expected, 'ordinary'].sort());
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

test('scoped phase routes validate active state over CLI, API, and inventory events', async t => {
  const f = await fixture(); t.after(() => f.close());
  const root = join(f.config.projectRoot, 'alpha');
  await mkdir(join(root, '.agent'));
  await writeFile(join(root, 'CLAUDE.md'), '@.agent/spec.md\n');
  const events = await socket(f, 'api/v1/events'); t.after(() => events.close());
  const current = () => events.packets.filter(p => p.type === 'inventory').at(-1)?.state.projects.find(p => p.name === 'alpha');
  const cases = [
    ['ITERATE \u2014 ', 'UNKNOWN'],
    ...['PROTOTYPE', 'ITERATE', 'IMPLEMENT', 'MAINTAIN'].map(phase => [
      `${phase} \u2014 private active scope\n> Phase: ITERATE \u2014 private request\nSuspended: IMPLEMENT \u2014 private suspended scope\nSuspended: MAINTAIN \u2014 CLI`, phase,
    ]),
    ['ITERATE \u2014 dashboard\nIMPLEMENT \u2014 backend', 'UNKNOWN'],
    ['Phase: IMPLEMENT \u2014 API\nSuspended: MAINTAIN \u2014 CLI', 'IMPLEMENT'],
    ['IMPLEMENT \u2014 API\nSuspended: MAINTAIN \u2014 ', 'UNKNOWN'],
    ['MAINTAIN \u2014 whole product', 'MAINTAIN'],
  ];
  for (const [state, expected] of cases) {
    const spec = `# Project\n\n## Intent\nBuild the product.\n\n## Artifacts\n\n## Decisions\n\n## Tasks\n- Queue: .agent/deferred.md\n\n## Phase\n${state}\n`;
    await writeFile(join(root, '.agent/spec.md'), spec);
    const cli = JSON.parse(await f.cli('projects')).projects.find(p => p.name === 'alpha');
    assert.equal(cli.phase, expected, state);
    assert.doesNotMatch(JSON.stringify(cli), /private active scope|private request|private suspended scope/);
    await until(() => current()?.phase === expected);
    assert.equal((await f.state()).projects.find(p => p.name === 'alpha').phase, expected, state);
    assert.deepEqual(current().features, []);
    assert.equal(await readFile(join(root, '.agent/spec.md'), 'utf8'), spec);
  }
});
