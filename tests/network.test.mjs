import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, readdir, rename, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import WebSocket from 'ws';
import { fixture, socket, until, sleep } from './network-helper.mjs';

const exec = promisify(execFile);
async function sessions(f) {
  const { stdout } = await exec('zmx', ['list'], { env: f.env, timeout: 5000 });
  return [...stdout.matchAll(/^\s*name=(.*?)\tpid=(\d+)\tclients=(\d+)/gm)]
    .map(([, name, pid, clients]) => ({ name, pid: Number(pid), clients: Number(clients) }));
}

function manualTerminal(f, name) {
  const child = spawn('script', ['--quiet', '--return', '--command',
    'exec zmx attach "$EMACHINE_TEST_SESSION" /bin/bash --noprofile --norc', '/dev/null'], {
    cwd: f.home, env: { ...f.env, TERM: 'xterm-256color', EMACHINE_TEST_SESSION: name },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let text = '';
  const ended = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  child.stdout.on('data', data => {
    text = (text + data.toString('utf8')).slice(-65536);
    if (data.includes(Buffer.from('\x1b[c'))) child.stdin.write('\x1b[?1;2c');
    if (data.includes(Buffer.from('\x1b[6n'))) child.stdin.write('\x1b[1;1R');
  });
  child.stderr.on('data', data => { text = (text + data).slice(-65536); });
  return {
    get text() { return text; },
    command(line) { child.stdin.write(line + '\r'); },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.stdin.end('\x1c');
      const timer = setTimeout(() => child.kill('SIGTERM'), 3000);
      try { await ended; } finally { clearTimeout(timer); }
    },
  };
}

test('project-named zmx session interoperability', { timeout: 120000 }, async t => {
  await t.test('missing sessions use the exact project name in the default namespace', async t => {
    const f = await fixture();
    const clients = [];
    t.after(async () => { for (const client of clients) await client.close(); await f.close(); });
    const project = (await f.state()).projects.find(p => p.name === 'alpha');
    assert.deepEqual(await sessions(f), []);
    const client = await socket(f, `api/v1/terminal/${project.id}`); clients.push(client);
    await until(() => client.packets.some(p => p.mode === 'control'));
    assert.equal(client.packets.find(p => p.type === 'state').session, project.name);
    await until(async () => (await sessions(f)).some(s => s.name === project.name));
    assert.deepEqual((await sessions(f)).map(s => s.name), [project.name]);
    client.command("printf '__NA''MED_CWD__%s\\n' \"$PWD\"");
    await until(() => client.text.includes(`__NAMED_CWD__${project.path}`));
  });

  for (const zmxDir of [false, true]) {
    await t.test(`reuse a manual session with ${zmxDir ? 'explicit ZMX_DIR' : 'default XDG namespace'}`, async t => {
      const f = await fixture({ zmxDir });
      const clients = [];
      t.after(async () => { for (const client of clients) await client.close(); await f.close(); });
      const project = (await f.state()).projects.find(p => p.name === 'beta');
      const manual = manualTerminal(f, project.name); clients.push(manual);
      manual.command("EMACHINE_MANUAL=from_manual; printf '__MAN''UAL_READY__%s\\n' \"$$\"");
      const ready = await until(() => manual.text.match(/__MANUAL_READY__(\d+)/));
      const shellPid = ready[1];
      const original = await until(async () => (await sessions(f)).find(s => s.name === project.name && s.clients === 1));
      for (const phase of ['active', 'restart', 'detached']) {
        if (phase !== 'active') { await f.stop(); await f.start(); }
        if (phase === 'detached') await manual.close();
        const client = await socket(f, `api/v1/terminal/${project.id}`); clients.push(client);
        await until(() => client.packets.some(p => p.mode === 'control'));
        client.command("printf '__RE''USE__%s:%s:%s\\n' \"$EMACHINE_MANUAL\" \"$$\" \"$PWD\"");
        const output = await until(() => client.text.match(/__REUSE__([^\r\n]*)/));
        assert.equal(output[1], `from_manual:${shellPid}:${f.home}`, phase);
        assert.equal(client.packets.find(p => p.type === 'state').session, project.name);
        await until(async () => (await sessions(f)).some(s => s.name === project.name && s.clients === (phase === 'detached' ? 1 : 2)));
        assert.deepEqual((await sessions(f)).map(s => [s.name, s.pid]), [[project.name, original.pid]]);
        await client.close();
      }
      assert.equal((await sessions(f))[0].pid, original.pid);
    });
  }

  await t.test('new attachments follow a renamed project without killing its old session', async t => {
    const f = await fixture();
    const clients = [];
    t.after(async () => { for (const client of clients) await client.close(); await f.close(); });
    const project = (await f.state()).projects.find(p => p.name === 'alpha');
    const old = await socket(f, `api/v1/terminal/${project.id}`); clients.push(old);
    await until(() => old.packets.some(p => p.mode === 'control'));
    const renamed = 'renamed project 東京';
    await rename(project.path, join(f.config.projectRoot, renamed));
    await until(async () => (await f.state()).projects.some(p => p.id === project.id && p.name === renamed));
    const client = await socket(f, `api/v1/terminal/${project.id}`); clients.push(client);
    await until(() => client.packets.some(p => p.type === 'state'));
    assert.equal(client.packets.find(p => p.type === 'state').session, renamed);
    await until(async () => (await sessions(f)).length === 2);
    assert.deepEqual((await sessions(f)).map(s => s.name).sort(), [project.name, renamed].sort());
    old.command("printf '__OL''D_ALIVE__\\n'");
    await until(() => old.text.includes('__OLD_ALIVE__'));
  });
});

test('real MoonBit machine server acceptance', { timeout: 180000 }, async t => {
  const f = await fixture();
  const sockets = [];
  t.after(async () => { for (const ws of sockets) await ws.close(); await f.close(); });
  let state = await f.state();
  const alpha = state.projects.find(p => p.name === 'alpha');
  const beta = state.projects.find(p => p.name === 'beta');
  const events = await socket(f, 'api/v1/events'); sockets.push(events);

  await t.test('health, exact origins, forwarded trust, CORS and path boundaries', async () => {
    assert.equal(state.protocol, 1); assert.equal(state.projects.length, 2);
    assert.equal((await f.request('api/v1/health')).status, 200);
    assert.equal((await f.request('api/v1/state', { headers: { Origin: 'https://untrusted.invalid' } })).status, 403);
    assert.equal((await f.request('api/v1/state', { headers: { 'X-Forwarded-For': '198.51.100.23' } })).status, 403);
    assert.equal((await f.request('api/v1/state', { headers: { 'X-Emachine-Gateway': 'incorrect' } })).status, 403);
    assert.equal((await f.request('api/v1/state', { headers: { 'X-Emachine-Gateway': f.config.gatewaySecret, 'X-Forwarded-For': '198.51.100.23' } })).status, 200);
    const preflight = await f.request('api/v1/state', { method: 'OPTIONS' });
    assert.equal(preflight.headers.get('access-control-allow-origin'), f.origin);
    assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
    assert.notEqual((await f.request('%2e%2e%2fREADME.md')).status, 200);
    const rejected = new WebSocket(f.origin.replace('http', 'ws') + '/api/v1/events');
    const denied = await new Promise(resolve => { rejected.once('unexpected-response', (_r, response) => { resolve(response.statusCode); rejected.terminate(); }); rejected.on('error', () => {}); });
    assert.equal(denied, 403);
  });

  await t.test('discovery and rename identity propagate without project metadata', async () => {
    await until(() => events.packets.some(e => e.type === 'inventory'));
    await mkdir(join(f.config.projectRoot, 'gamma'));
    await until(async () => (await f.state()).projects.length === 3);
    assert.ok(events.packets.some(e => e.state?.projects.some(p => p.name === 'gamma')));
    await rename(join(f.config.projectRoot, 'gamma'), join(f.config.projectRoot, 'delta'));
    const old = events.packets.findLast(e => e.state?.projects.some(p => p.name === 'gamma')).state.projects.find(p => p.name === 'gamma');
    await until(async () => (await f.state()).projects.some(p => p.name === 'delta' && p.id === old.id));
    await rm(join(f.config.projectRoot, 'delta'), { recursive: true });
    await until(async () => (await f.state()).projects.length === 2);
    assert.deepEqual(await readdir(alpha.path), []); assert.deepEqual(await readdir(beta.path), []);
  });

  await t.test('zmx terminal cwd, Unicode, two-device control, resize and restart', async () => {
    const a = await socket(f, `api/v1/terminal/${alpha.id}?cols=90&rows=28`); sockets.push(a);
    await until(() => a.packets.some(p => p.mode === 'control'));
    a.command("EMACHINE_KEEP=still_here; printf '__CW''D__%s\\n' \"$PWD\"; printf '__UN''ICODE__π東京\\n'");
    await until(() => a.text.includes(`__CWD__${alpha.path}`) && a.text.includes('__UNICODE__π東京'));
    const b = await socket(f, `api/v1/terminal/${alpha.id}?cols=42&rows=19`); sockets.push(b);
    await until(() => b.packets.some(p => p.mode === 'observe' && p.cols === 90));
    b.command('EMACHINE_KEEP=wrong');
    b.control({ type: 'claim' });
    await until(() => b.packets.at(-1)?.mode === 'control' && a.packets.at(-1)?.mode === 'observe');
    b.control({ type: 'resize', cols: 111, rows: 37 });
    b.command("stty size; printf '__ST''ATE__%s\\n' \"$EMACHINE_KEEP\"");
    await until(() => b.text.includes('37 111') && b.text.includes('__STATE__still_here'));
    await a.close(); await b.close();
    await f.stop(); await f.start();
    const c = await socket(f, `api/v1/terminal/${alpha.id}`); sockets.push(c);
    await until(() => c.packets.some(p => p.mode === 'control'));
    c.command("printf '__REST''ART__%s\\n' \"$EMACHINE_KEEP\"");
    await until(() => c.text.includes('__RESTART__still_here'));
    await c.close();
  });

  let aWorkspace;
  let bRevision;
  await t.test('project-owned releases, failed builds, symlink rejection and source recovery', async () => {
    aWorkspace = JSON.parse(await f.cli('feature', 'create', 'alpha', 'map', 'Alpha map')).workspace;
    const bWorkspace = JSON.parse(await f.cli('feature', 'create', 'beta', 'map', 'Beta map')).workspace;
    assert.notEqual(aWorkspace, bWorkspace);
    const first = JSON.parse(await f.cli('feature', 'activate', 'alpha', 'map'));
    bRevision = JSON.parse(await f.cli('feature', 'activate', 'beta', 'map')).revision;
    const manifest = await readFile(join(aWorkspace, 'feature.json'), 'utf8');
    await writeFile(join(aWorkspace, 'feature.json'), JSON.stringify({ id: 'map', title: 'Broken', build: ['/bin/false'] }));
    await assert.rejects(() => f.cli('feature', 'activate', 'alpha', 'map'));
    await until(async () => (await f.state()).projects.find(p => p.id === alpha.id).diagnostics.length);
    state = await f.state();
    assert.equal(state.projects.find(p => p.id === alpha.id).features[0].revision, first.revision);
    assert.equal(state.projects.find(p => p.id === beta.id).features[0].revision, bRevision);
    await writeFile(join(aWorkspace, 'feature.json'), manifest);
    await symlink('/etc/passwd', join(aWorkspace, 'escape.txt'));
    await assert.rejects(() => f.cli('feature', 'activate', 'alpha', 'map'));
    await rm(join(aWorkspace, 'escape.txt'));
    const before = await f.cli('feature', 'begin', 'alpha', 'map');
    const original = await readFile(join(aWorkspace, 'index.html'), 'utf8');
    await writeFile(join(aWorkspace, 'index.html'), '<title>New version</title><p id="result">Alpha only</p>');
    const second = JSON.parse(await f.cli('feature', 'activate', 'alpha', 'map'));
    assert.notEqual(first.revision, second.revision);
    assert.match(await (await f.request(second.entry)).text(), /Alpha only/);
    await f.cli('feature', 'restore', 'alpha', 'map', before);
    assert.equal(await readFile(join(aWorkspace, 'index.html'), 'utf8'), original);
    assert.equal((await f.state()).projects.find(p => p.id === beta.id).features[0].revision, bRevision);
    assert.deepEqual(await readdir(alpha.path), []); assert.deepEqual(await readdir(beta.path), []);
  });

  await t.test('manual staleness, durable jobs, artifacts and render diagnostics', async () => {
    await writeFile(join(alpha.path, 'input.txt'), 'first input');
    const manifest = { id: 'map', title: 'Analysis', entry: 'index.html', watch: ['input.txt'], refresh: 'manual', actions: {
      analyze: ['/bin/sh', '-c', 'sleep 0.4; cat > "$EMACHINE_ARTIFACTS/result.json"; printf completed'],
    } };
    await writeFile(join(aWorkspace, 'feature.json'), JSON.stringify(manifest));
    const feature = JSON.parse(await f.cli('feature', 'activate', 'alpha', 'map'));
    await writeFile(join(alpha.path, 'input.txt'), 'second input');
    await until(async () => (await f.state()).projects.find(p => p.id === alpha.id).features[0].status === 'stale');
    assert.equal((await (await f.request('api/v1/jobs')).json()).jobs.length, 0);
    const started = await f.request(`api/v1/projects/${alpha.id}/features/map/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'analyze', input: { real: 'result' } }) });
    assert.equal(started.status, 202); const job = await started.json();
    await assert.rejects(() => f.cli('feature', 'checkpoint', 'alpha', 'map'));
    await until(async () => (await (await f.request(`api/v1/jobs/${job.id}`)).json()).status === 'succeeded');
    assert.match(await (await f.request(`api/v1/jobs/${job.id}/log`)).text(), /completed/);
    assert.deepEqual(await (await f.request(`api/v1/artifacts/${alpha.id}/map/result.json`)).json(), { real: 'result' });
    await until(async () => (await f.state()).projects.find(p => p.id === alpha.id).features[0].status === 'ready');
    const report = await f.request(`api/v1/projects/${alpha.id}/features/map/errors`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: feature.revision, message: 'Render failure probe' }) });
    assert.equal(report.status, 200);
    await until(async () => (await f.state()).projects.find(p => p.id === alpha.id).diagnostics.some(d => d.message === 'Render failure probe'));
    await f.stop(); await f.start();
    assert.equal((await (await f.request(`api/v1/jobs/${job.id}`)).json()).status, 'succeeded');
  });

  await t.test('newer activations win; removing a tab does not affect another project', async () => {
    const slow = { id: 'map', title: 'Older', entry: 'index.html', build: ['/bin/sh', '-c', 'echo started; sleep 0.6'] };
    await writeFile(join(aWorkspace, 'feature.json'), JSON.stringify(slow));
    const old = f.cli('feature', 'activate', 'alpha', 'map').then(() => 'published', () => 'superseded');
    await until(async () => (await readFile(join(aWorkspace, '../build.log'), 'utf8')).includes('started'));
    await writeFile(join(aWorkspace, 'feature.json'), JSON.stringify({ id: 'map', title: 'Newest', entry: 'index.html' }));
    const latest = f.cli('feature', 'activate', 'alpha', 'map');
    assert.equal(await old, 'superseded');
    assert.equal(JSON.parse(await latest).title, 'Newest');
    await f.cli('feature', 'remove', 'alpha', 'map');
    await until(async () => (await f.state()).projects.find(p => p.id === alpha.id).features.length === 0);
    assert.equal((await f.state()).projects.find(p => p.id === beta.id).features[0].revision, bRevision);
    assert.deepEqual(await readdir(alpha.path), ['input.txt']);
    assert.deepEqual(await readdir(beta.path), []);
  });
});
