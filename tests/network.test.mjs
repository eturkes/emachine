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

function manualTerminal(f, name, dimensions) {
  const child = spawn('script', ['--quiet', '--return', '--command',
    `${dimensions ? 'stty rows "$EMACHINE_TEST_ROWS" cols "$EMACHINE_TEST_COLS"; ' : ''}exec zmx attach "$EMACHINE_TEST_SESSION" /bin/bash --noprofile --norc`, '/dev/null'], {
    cwd: f.home, env: { ...f.env, TERM: 'xterm-256color', EMACHINE_TEST_SESSION: name,
      ...(dimensions ? { EMACHINE_TEST_COLS: String(dimensions.cols), EMACHINE_TEST_ROWS: String(dimensions.rows) } : {}) },
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
  await t.test('manual leader geometry precedes replay and stays distinct from requested resize', async t => {
    const f = await fixture();
    const clients = [];
    t.after(async () => { for (const client of clients) await client.close(); await f.close(); });
    const project = (await f.state()).projects.find(p => p.name === 'alpha');
    const manual = manualTerminal(f, project.name, { cols: 100, rows: 30 }); clients.push(manual);
    manual.command("printf '__MANUAL_''GRID__'; stty size; printf '__REPLAY_''MARKER__\\n'");
    await until(() => manual.text.includes('__MANUAL_GRID__30 100'));

    const frames = [];
    let currentState;
    const ws = new WebSocket(`${f.origin.replace('http', 'ws')}/api/v1/terminal/${project.id}?cols=40&rows=20`, { headers: { Origin: f.origin } });
    const client = {
      async close() {
        if (ws.readyState === WebSocket.CLOSED) return;
        const done = new Promise(resolve => ws.once('close', resolve));
        ws.close(); const timer = setTimeout(() => ws.terminate(), 1000);
        try { await done; } finally { clearTimeout(timer); }
      },
      command(line) { ws.send(Buffer.from(line + '\r')); },
    };
    clients.push(client);
    let text = '';
    ws.on('message', (data, binary) => {
      if (binary) {
        text = (text + data.toString()).slice(-65536);
        frames.push({ state: currentState, bytes: data.toString(), through: text });
        if (data.includes(Buffer.from('\x1b[c'))) ws.send(Buffer.from('\x1b[?1;2c'));
        if (data.includes(Buffer.from('\x1b[6n'))) ws.send(Buffer.from('\x1b[1;1R'));
      } else {
        const packet = JSON.parse(data.toString());
        if (packet.type === 'state') currentState = packet;
      }
    });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    await until(() => text.includes('__REPLAY_MARKER__'));
    assert.deepEqual(frames[0].state, {
      type: 'state', session: 'alpha', mode: 'control', cols: 40, rows: 20, screenCols: 100, screenRows: 30,
    });

    ws.send(JSON.stringify({ type: 'resize', cols: 55, rows: 17 }));
    await until(() => currentState.cols === 55 && currentState.rows === 17);
    manual.command("printf '__AFTER_''RESIZE__'; stty size");
    await until(() => text.includes('__AFTER_RESIZE__30 100'));
    assert.equal(currentState.screenCols, 100);
    assert.equal(currentState.screenRows, 30);

    ws.send(Buffer.from(' '));
    await sleep(200);
    client.command("printf '__AFTER_''INPUT__'; stty size");
    await until(() => text.includes('__AFTER_INPUT__17 55'));
    assert.equal(currentState.screenCols, 55);
    assert.equal(currentState.screenRows, 17);
    const inputFrame = frames.find(frame => frame.through.includes('__AFTER_INPUT__17 55'));
    assert.equal(inputFrame?.state.screenCols, 55);
    assert.equal(inputFrame?.state.screenRows, 17);
  });

  await t.test('silent terminal resize publishes the observed grid without more input or output', async t => {
    const f = await fixture();
    let client;
    t.after(async () => { await client?.close(); await f.close(); });
    const project = (await f.state()).projects.find(p => p.name === 'alpha');
    client = await socket(f, `api/v1/terminal/${project.id}?cols=80&rows=24`);
    client.command("stty -echo; printf '__SILENT_''READY__\\n'; sleep 5; printf '__SILENT_''DONE__\\n'");
    await until(() => client.text.includes('__SILENT_READY__'));
    await until(() => client.packets.some(packet => packet.screenCols === 80 && packet.screenRows === 24));
    const quiet = client.text;
    client.control({ type: 'resize', cols: 72, rows: 19 });
    await until(() => client.packets.some(packet => packet.screenCols === 72 && packet.screenRows === 19), 1500);
    assert.equal(client.text, quiet, 'geometry updates must not require program output or injected input');
  });

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
    const started = join(f.home, 'older-build-started'), release = join(f.home, 'release-older-build');
    const waitForRelease = `
      import { access, writeFile } from 'node:fs/promises';
      import { setTimeout } from 'node:timers/promises';
      const [started, release] = process.argv.slice(1);
      await writeFile(started, 'started', { flag: 'wx' });
      const deadline = Date.now() + 30000;
      for (;;) {
        try { await access(release); break; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (Date.now() >= deadline) throw new Error('Older build release timed out.');
        await setTimeout(20);
      }
    `;
    const slow = { id: 'map', title: 'Older', entry: 'index.html', build: [process.execPath, '--input-type=module', '-e', waitForRelease, started, release] };
    await writeFile(join(aWorkspace, 'feature.json'), JSON.stringify(slow));
    let olderFailure = '', latest;
    const old = f.cli('feature', 'activate', 'alpha', 'map').then(() => 'published', error => {
      olderFailure = [error.stdout, error.stderr, error.message].join('\n'); return 'superseded';
    });
    try {
      await until(async () => (await readFile(started, 'utf8')) === 'started');
      const requested = join(aWorkspace, '../requested.json');
      const olderRequest = JSON.parse(await readFile(requested, 'utf8')).id;
      await writeFile(join(aWorkspace, 'feature.json'), JSON.stringify({ id: 'map', title: 'Newest', entry: 'index.html' }));
      latest = f.cli('feature', 'activate', 'alpha', 'map');
      void latest.catch(() => {});
      // Registration precedes the project lock; the newer build cannot start until the older one exits.
      await until(async () => JSON.parse(await readFile(requested, 'utf8')).id !== olderRequest);
      await writeFile(release, 'release');
      assert.equal(await old, 'superseded');
      assert.match(olderFailure, /Activation superseded by a newer request/);
      assert.equal(JSON.parse(await latest).title, 'Newest');
    } finally {
      try { await writeFile(release, 'release'); }
      finally { await Promise.allSettled([old, latest]); }
    }
    await f.cli('feature', 'remove', 'alpha', 'map');
    await until(async () => (await f.state()).projects.find(p => p.id === alpha.id).features.length === 0);
    assert.equal((await f.state()).projects.find(p => p.id === beta.id).features[0].revision, bRevision);
    assert.deepEqual(await readdir(alpha.path), ['input.txt']);
    assert.deepEqual(await readdir(beta.path), []);
  });
});
