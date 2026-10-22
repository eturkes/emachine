import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import WebSocket from 'ws';
import { fixture, socket, until } from './network-helper.mjs';

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
async function rejectedUpgrade(f, path, headers) {
  const ws = new WebSocket(f.origin.replace('http', 'ws') + '/' + path, { headers, handshakeTimeout: 5000 });
  return new Promise((resolve, reject) => {
    ws.on('error', () => {});
    ws.once('unexpected-response', (_request, response) => { response.resume(); ws.terminate(); resolve(response.statusCode); });
    ws.once('open', () => { ws.close(); reject(new Error('An invalid terminal upgrade was accepted.')); });
    ws.once('error', error => { if (!String(error).includes('closed before the connection was established')) reject(error); });
  });
}

test('General creates exact independent sessions at home without projects and preserves them after detach and restart', { timeout: 60000 }, async t => {
  const f = await fixture();
  const clients = [];
  t.after(async () => { for (const client of clients) await client.close(); await f.close(); });
  for (const name of ['alpha', 'beta']) await rm(join(f.config.projectRoot, name), { recursive: true });
  await until(async () => (await f.state()).projects.length === 0);
  assert.deepEqual((await f.state()).projects, []);
  assert.deepEqual(await sessions(f), []);
  const general = await socket(f, 'api/v1/terminal/general/general?cols=91&rows=28'); clients.push(general);
  await until(() => general.packets.some(p => p.type === 'state' && p.mode === 'control'));
  assert.equal(general.packets.find(p => p.type === 'state').session, 'general');
  general.command("EMACHINE_GENERAL=retained; printf '__HOME''__%s:%s\\n' \"$PWD\" \"$$\"");
  const initial = await until(() => general.text.match(/__HOME__([^\r\n]+)/));
  assert.ok(initial[1].startsWith(f.home + ':'));
  const shellPid = initial[1].slice(f.home.length + 1);
  for (const name of ['general2', 'general3']) {
    const client = await socket(f, 'api/v1/terminal/general/' + name); clients.push(client);
    await until(() => client.packets.some(p => p.type === 'state' && p.mode === 'control' && p.session === name));
    client.command("printf '__SEPAR''ATE__%s:%s\\n' \"$PWD\" \"$EMACHINE_GENERAL\"");
    const output = await until(() => client.text.match(/__SEPARATE__([^\r\n]+)/));
    assert.equal(output[1], f.home + ':');
  }
  await until(async () => (await sessions(f)).length === 3);
  const original = (await sessions(f)).sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(original.map(s => s.name), ['general', 'general2', 'general3']);
  for (const client of clients) await client.close();
  await until(async () => (await sessions(f)).every(s => s.clients === 0));
  await f.stop(); await f.start();
  assert.deepEqual((await sessions(f)).sort((a, b) => a.name.localeCompare(b.name)).map(s => [s.name, s.pid]), original.map(s => [s.name, s.pid]));
  const resumed = await socket(f, 'api/v1/terminal/general/general'); clients.push(resumed);
  await until(() => resumed.packets.some(p => p.mode === 'control'));
  resumed.command("printf '__RESU''MED__%s:%s\\n' \"$EMACHINE_GENERAL\" \"$$\"");
  await until(() => resumed.text.includes('__RESUMED__retained:' + shellPid));
});

test('General reuses a manual numbered session and inherited ZMX_DIR without resetting its shell or cwd', { timeout: 60000 }, async t => {
  const f = await fixture({ zmxDir: true });
  const clients = [];
  t.after(async () => { for (const client of clients) await client.close(); await f.close(); });
  await mkdir(join(f.home, 'manual-cwd'));
  const manual = manualTerminal(f, 'general2'); clients.push(manual);
  manual.command("cd manual-cwd; EMACHINE_MANUAL=retained; printf '__MANU''AL__%s\\n' \"$$\"");
  const ready = await until(() => manual.text.match(/__MANUAL__(\d+)/));
  const original = await until(async () => (await sessions(f)).find(s => s.name === 'general2'));
  for (const phase of ['attached', 'detached']) {
    if (phase === 'detached') { await manual.close(); await f.stop(); await f.start(); }
    const client = await socket(f, 'api/v1/terminal/general/general2'); clients.push(client);
    await until(() => client.packets.some(p => p.mode === 'control'));
    client.command("printf '__EXIS''TING__%s:%s:%s\\n' \"$EMACHINE_MANUAL\" \"$$\" \"$PWD\"");
    await until(() => client.text.includes('__EXISTING__retained:' + ready[1] + ':' + join(f.home, 'manual-cwd')));
    assert.equal((await sessions(f)).find(s => s.name === 'general2').pid, original.pid);
    await client.close();
  }
  assert.deepEqual((await sessions(f)).map(s => s.name), ['general2']);
});

test('General shares control with a same-named project while another numbered session stays independent', { timeout: 60000 }, async t => {
  const f = await fixture();
  const clients = [];
  t.after(async () => { for (const client of clients) await client.close(); await f.close(); });
  await mkdir(join(f.config.projectRoot, 'general'));
  const project = await until(async () => (await f.state()).projects.find(p => p.name === 'general'));
  assert.ok(project);
  const a = await socket(f, 'api/v1/terminal/general/general?cols=90&rows=28'); clients.push(a);
  await until(() => a.packets.some(p => p.mode === 'control'));
  a.command("EMACHINE_CONTROL=kept; printf '__SET''__\\n'");
  await until(() => a.text.includes('__SET__'));
  const b = await socket(f, 'api/v1/terminal/' + project.id + '?cols=40&rows=18'); clients.push(b);
  await until(() => b.packets.some(p => p.mode === 'observe' && p.cols === 90 && p.rows === 28));
  const separate = await socket(f, 'api/v1/terminal/general/general2'); clients.push(separate);
  await until(() => separate.packets.some(p => p.mode === 'control'));
  b.command('EMACHINE_CONTROL=wrong');
  b.control({ type: 'claim' });
  await until(() => b.packets.at(-1)?.mode === 'control' && a.packets.at(-1)?.mode === 'observe');
  b.control({ type: 'resize', cols: 110, rows: 35 });
  b.command("stty size; printf '__CONTROL''__%s\\n' \"$EMACHINE_CONTROL\"");
  await until(() => b.text.includes('35 110') && b.text.includes('__CONTROL__kept'));
  await until(() => a.packets.at(-1)?.cols === 110 && a.packets.at(-1)?.rows === 35);
  assert.equal(separate.packets.at(-1)?.mode, 'control');
  await b.close();
  await until(() => a.packets.at(-1)?.mode === 'control');
  assert.equal((await sessions(f)).filter(s => s.name === 'general').length, 1);
});

test('General rejects noncanonical names and keeps the exact Origin and owner boundaries', { timeout: 45000 }, async t => {
  const f = await fixture();
  const clients = [];
  t.after(async () => { for (const client of clients) await client.close(); await f.close(); });
  const path = 'api/v1/terminal/general/general';
  for (const headers of [
    {},
    { Origin: 'https://untrusted.invalid' },
    { Origin: f.origin + '/' },
    { Origin: f.origin, 'X-Forwarded-For': '198.51.100.23' },
    { Origin: f.origin, 'Tailscale-User-Login': 'another-user' },
    { Origin: f.origin, 'X-Emachine-Gateway': 'incorrect' },
  ]) assert.equal(await rejectedUpgrade(f, path, headers), 403);
  for (const name of ['', 'general0', 'general1', 'general01', 'general-2', 'general2extra', 'General', 'other', 'general%202', 'general%00', 'general' + '2'.repeat(42)]) {
    assert.equal(await rejectedUpgrade(f, 'api/v1/terminal/general/' + name, { Origin: f.origin }), 400, name);
  }
  assert.deepEqual(await sessions(f), []);
  const client = await socket(f, 'api/v1/terminal/general/general10', { 'X-Emachine-Gateway': f.config.gatewaySecret, 'X-Forwarded-For': '198.51.100.23' });
  clients.push(client);
  await until(() => client.packets.some(p => p.session === 'general10' && p.mode === 'control'));
});
