import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir, rename, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import WebSocket from 'ws';
import { fixture, socket, until, sleep } from './network-helper.mjs';

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
