import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import WebSocket from 'ws';
import { fixture, socket, until, sleep } from './network-helper.mjs';

const exec = promisify(execFile);

async function sessions(f) {
  const { stdout } = await exec('zmx', ['list'], { env: f.env, timeout: 5000 });
  return [...stdout.matchAll(/^\s*name=(.*?)\tpid=(\d+)\tclients=(\d+)/gm)]
    .map(([, name, pid, clients]) => ({ name, pid: Number(pid), clients: Number(clients) }));
}

async function resumedSocket(f, path, previous) {
  const separator = path.includes('?') ? '&' : '?';
  const ws = new WebSocket(`${f.origin.replace('http', 'ws')}/${path}${separator}resume=1`, {
    headers: { Origin: f.origin }, maxPayload: 8 * 1024 * 1024,
  });
  const packets = [], events = [], violations = [];
  let header, sequence = previous?.sequence ?? 0, text = '', ready = false;
  ws.on('message', (data, binary) => {
    if (binary) {
      if (!header) { violations.push('binary data arrived before resume negotiation'); return; }
      if (data.length < 8) { violations.push('output lacks its sequence prefix'); return; }
      const next = Number(data.readBigUInt64BE(0));
      if (next !== sequence + 1) violations.push(`output sequence ${next} follows ${sequence}`);
      sequence = next;
      const bytes = data.subarray(8);
      const decoded = bytes.toString('utf8');
      text = (text + decoded).slice(-4 * 1024 * 1024);
      events.push({ sequence, data: decoded });
      if (bytes.includes(Buffer.from('\x1b[c'))) ws.send(Buffer.from('\x1b[?1;2c'));
      if (bytes.includes(Buffer.from('\x1b[6n'))) ws.send(Buffer.from('\x1b[1;1R'));
      return;
    }
    const packet = JSON.parse(data.toString());
    packets.push(packet);
    if (packet.type === 'resume') {
      if (header) violations.push('duplicate resume negotiation');
      header = packet; sequence = packet.sequence;
    } else if (packet.type === 'state') {
      if (!header) { violations.push('state arrived before resume negotiation'); return; }
      if (packet.sequence !== sequence + 1) violations.push(`state sequence ${packet.sequence} follows ${sequence}`);
      sequence = packet.sequence; events.push({ sequence, state: packet });
    } else if (packet.type === 'ready') ready = true;
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ type: 'resume', ...previous }));
  return {
    ws, packets, events, violations,
    get header() { return header; }, get sequence() { return sequence; }, get text() { return text; },
    checkpoint() { return { attachment: header.attachment, sequence }; },
    async ready() {
      await until(() => ready && header, 3000);
      assert.deepEqual(violations, [], 'resume packets must be ordered and lossless');
      assert.match(header.attachment, /^[0-9a-f]{32}$/);
      return header;
    },
    command(line) { ws.send(Buffer.from(line + '\r')); },
    control(value) { ws.send(JSON.stringify(value)); },
    async close() {
      if (ws.readyState === WebSocket.CLOSED) return;
      const ended = new Promise(resolve => ws.once('close', resolve));
      ws.close(); const timer = setTimeout(() => ws.terminate(), 1000);
      try { await ended; } finally { clearTimeout(timer); }
    },
  };
}

async function setup(t) {
  const f = await fixture();
  const clients = [];
  t.after(async () => { for (const client of clients) await client.close(); await f.close(); });
  const project = (await f.state()).projects.find(p => p.name === 'alpha');
  const path = `api/v1/terminal/${project.id}?cols=100&rows=30`;
  const connect = async previous => { const client = await resumedSocket(f, path, previous); clients.push(client); return client; };
  return { f, clients, project, path, connect };
}

test('terminal resume retains the attachment and sends only missed output', { timeout: 20000 }, async t => {
  const { f, connect } = await setup(t);
  const first = await connect();
  assert.equal((await first.ready()).resumed, false);
  first.command("stty -echo; printf '__KEPT_''BEFORE__\\n'");
  await until(() => first.text.includes('__KEPT_BEFORE__'));
  const checkpoint = first.checkpoint();
  const original = (await sessions(f)).find(s => s.name === 'alpha');
  await first.close();
  await sleep(200);
  assert.equal((await sessions(f)).find(s => s.name === 'alpha')?.clients, 1, 'the detached lease keeps one attachment');
  await exec('zmx', ['print', 'alpha', '__DURING_GAP_界__\r\n'], { env: f.env, timeout: 5000 });
  const next = await connect(checkpoint);
  const resumed = await next.ready();
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.attachment, checkpoint.attachment);
  await until(() => next.text.includes('__DURING_GAP_界__'));
  assert.equal(next.text.includes('__KEPT_BEFORE__'), false, 'history already parsed by the client must not be replayed');
  assert.deepEqual(next.violations, []);
  const history = (await exec('zmx', ['history', 'alpha'], { env: f.env, timeout: 5000 })).stdout;
  assert.ok(history.includes('__KEPT_BEFORE__') && history.includes('__DURING_GAP_界__'), 'daemon scrollback is preserved');
  const current = (await sessions(f)).find(s => s.name === 'alpha');
  assert.equal(current.pid, original.pid);
  assert.equal(current.clients, 1);
});

test('terminal resume fences a replaced live socket', { timeout: 20000 }, async t => {
  const { f, connect } = await setup(t);
  const first = await connect(); await first.ready();
  first.command("stty -echo; printf '__TAKEOVER_''READY__\\n'");
  await until(() => first.text.includes('__TAKEOVER_READY__'));
  const next = await connect(first.checkpoint());
  assert.equal((await next.ready()).resumed, true);
  await until(() => first.ws.readyState === WebSocket.CLOSED);
  next.command("printf '__ONLY_NEW_''SOCKET__\\n'");
  await until(() => next.text.includes('__ONLY_NEW_SOCKET__'));
  assert.equal((await sessions(f)).find(s => s.name === 'alpha').clients, 1);
  assert.deepEqual(next.violations, []);
});

test('terminal resume replays geometry before output and preserves control handover', { timeout: 20000 }, async t => {
  const { f, clients, path, connect } = await setup(t);
  const first = await connect(); await first.ready();
  first.command("stty -echo; printf '__GEOMETRY_''READY__\\n'");
  await until(() => first.text.includes('__GEOMETRY_READY__'));
  const observer = await socket(f, path); clients.push(observer);
  await until(() => observer.packets.some(p => p.mode === 'observe'));
  const checkpoint = first.checkpoint();
  await first.close();
  await until(() => observer.packets.at(-1)?.mode === 'control');
  observer.control({ type: 'resize', cols: 72, rows: 19 });
  observer.command("printf '__GAP_''GEOMETRY__\\n'");
  await until(() => observer.text.includes('__GAP_GEOMETRY__'));
  await until(() => observer.packets.some(p => p.screenCols === 72 && p.screenRows === 19));
  const next = await connect(checkpoint); await next.ready();
  await until(() => next.text.includes('__GAP_GEOMETRY__'));
  const grid = next.events.findIndex(e => e.state?.screenCols === 72 && e.state?.screenRows === 19);
  const output = next.events.findIndex(e => e.data?.includes('__GAP_GEOMETRY__'));
  assert.ok(grid >= 0 && output > grid, 'the missed grid change must precede its bytes');
  assert.equal(next.packets.filter(p => p.type === 'state').at(-1).mode, 'observe');
  next.command("printf '__OBSERVER_''INJECTED__\\n'");
  observer.command("printf '__CONTROL_''CONFIRMED__\\n'");
  await until(() => next.text.includes('__CONTROL_CONFIRMED__'));
  assert.equal(next.text.includes('__OBSERVER_INJECTED__'), false);
  next.control({ type: 'claim' });
  await until(() => next.packets.filter(p => p.type === 'state').at(-1).mode === 'control');
  assert.deepEqual(next.violations, []);
});

test('terminal resume rejects a foreign room token and invalid checkpoints without disturbing other sessions', { timeout: 20000 }, async t => {
  const { f, clients, connect } = await setup(t);
  const first = await connect(); await first.ready();
  first.command("stty -echo; printf '__FALLBACK_''HISTORY__\\n'");
  await until(() => first.text.includes('__FALLBACK_HISTORY__'));
  const checkpoint = first.checkpoint();
  const foreign = await resumedSocket(f, 'api/v1/terminal/general/general2', checkpoint); clients.push(foreign);
  assert.equal((await foreign.ready()).resumed, false);
  assert.notEqual(foreign.header.attachment, checkpoint.attachment);
  assert.equal(first.ws.readyState, WebSocket.OPEN);
  const reset = await connect({ ...checkpoint, sequence: checkpoint.sequence + 1000000 });
  assert.equal((await reset.ready()).resumed, false);
  assert.notEqual(reset.header.attachment, checkpoint.attachment);
  await until(() => reset.text.includes('__FALLBACK_HISTORY__'));
  await until(() => first.ws.readyState === WebSocket.CLOSED);
  assert.equal((await sessions(f)).find(s => s.name === 'general2').clients, 1);
  assert.deepEqual(reset.violations, []);
});

test('terminal resume falls back to a full restore after server restart', { timeout: 20000 }, async t => {
  const { f, connect } = await setup(t);
  const first = await connect(); await first.ready();
  first.command("stty -echo; printf '__SERVER_''RESTART__\\n'");
  await until(() => first.text.includes('__SERVER_RESTART__'));
  const checkpoint = first.checkpoint();
  const original = (await sessions(f)).find(s => s.name === 'alpha');
  await f.stop(); await f.start();
  const next = await connect(checkpoint);
  assert.equal((await next.ready()).resumed, false);
  assert.notEqual(next.header.attachment, checkpoint.attachment);
  await until(() => next.text.includes('__SERVER_RESTART__'));
  assert.equal((await sessions(f)).find(s => s.name === 'alpha').pid, original.pid);
});

test('terminal resume detects a bounded journal gap instead of silently losing output', { timeout: 30000 }, async t => {
  const { f, connect } = await setup(t);
  const first = await connect(); await first.ready();
  const trigger = join(f.home, 'resume-burst');
  await writeFile(join(f.home, 'resume-burst.py'), `import os,sys,time\nprint('__BURST_READY__', flush=True)\nwhile not os.path.exists(${JSON.stringify(trigger)}): time.sleep(0.01)\nfor n in range(120000): sys.stdout.write('burst-%06d ' % n + 'x'*80 + '\\n')\nprint('__BURST_DONE__', flush=True)\n`);
  first.command(`stty -echo; python3 -u '${join(f.home, 'resume-burst.py')}'`);
  await until(() => first.text.includes('__BURST_READY__'));
  const checkpoint = first.checkpoint();
  await first.close();
  await writeFile(trigger, 'go');
  await until(async () => (await exec('zmx', ['history', 'alpha'], { env: f.env, timeout: 5000, maxBuffer: 4 * 1024 * 1024 })).stdout.includes('__BURST_DONE__'), 15000);
  const next = await connect(checkpoint);
  assert.equal((await next.ready()).resumed, false);
  await until(() => next.text.includes('__BURST_DONE__'));
  assert.deepEqual(next.violations, []);
});

test('terminal resume expires detached leases without killing the shell', { timeout: 45000 }, async t => {
  const { f, connect } = await setup(t);
  const first = await connect(); await first.ready();
  first.command("stty -echo; printf '__EXPIRY_''HISTORY__\\n'");
  await until(() => first.text.includes('__EXPIRY_HISTORY__'));
  const checkpoint = first.checkpoint();
  const original = (await sessions(f)).find(s => s.name === 'alpha');
  await first.close();
  await until(async () => (await sessions(f)).find(s => s.name === 'alpha')?.clients === 0, 33000);
  const next = await connect(checkpoint);
  assert.equal((await next.ready()).resumed, false);
  await until(() => next.text.includes('__EXPIRY_HISTORY__'));
  assert.equal((await sessions(f)).find(s => s.name === 'alpha').pid, original.pid);
});

test('terminal resume releases an explicitly detached pane without killing the shell', { timeout: 20000 }, async t => {
  const { f, connect } = await setup(t);
  const first = await connect(); await first.ready();
  first.command("stty -echo; printf '__DETACH_''HISTORY__\\n'");
  await until(() => first.text.includes('__DETACH_HISTORY__'));
  const checkpoint = first.checkpoint();
  const original = (await sessions(f)).find(s => s.name === 'alpha');
  first.control({ type: 'detach' });
  await until(() => first.ws.readyState === WebSocket.CLOSED);
  await until(async () => (await sessions(f)).find(s => s.name === 'alpha')?.clients === 0, 3000);
  const next = await connect(checkpoint);
  assert.equal((await next.ready()).resumed, false);
  await until(() => next.text.includes('__DETACH_HISTORY__'));
  assert.equal((await sessions(f)).find(s => s.name === 'alpha').pid, original.pid);
});

test('terminal resume bounds detached leases and never evicts an active peer', { timeout: 30000 }, async t => {
  const { f, connect } = await setup(t);
  const active = await connect(); await active.ready();
  active.command("stty -echo; printf '__BUDGET_''HISTORY__\\n'");
  await until(() => active.text.includes('__BUDGET_HISTORY__'));
  const oldest = await connect(); await oldest.ready();
  await until(() => oldest.text.includes('__BUDGET_HISTORY__'));
  const checkpoint = oldest.checkpoint();
  const detachedAt = Date.now();
  await oldest.close();
  await Promise.all(Array.from({ length: 32 }, async () => {
    const client = await connect(); await client.ready(); await client.close();
  }));
  assert.ok(Date.now() - detachedAt < 30000, 'eviction is tested before ordinary lease expiry');
  assert.equal(active.ws.readyState, WebSocket.OPEN, 'the detached budget excludes active bindings');
  const replacement = await connect(checkpoint);
  assert.equal((await replacement.ready()).resumed, false);
  assert.notEqual(replacement.header.attachment, checkpoint.attachment);
  await until(() => replacement.text.includes('__BUDGET_HISTORY__'));
  active.command("printf '__ACTIVE_''SURVIVED__\\n'");
  await until(() => active.text.includes('__ACTIVE_SURVIVED__'));
  assert.equal(active.packets.filter(p => p.type === 'state').at(-1).mode, 'control');
  assert.ok((await sessions(f)).find(s => s.name === 'alpha').clients <= 34);
});

test('terminal resume bounds negotiation before spawning an attachment', { timeout: 15000 }, async t => {
  const { f, path } = await setup(t);
  const ws = new WebSocket(`${f.origin.replace('http', 'ws')}/${path}&resume=1`, { headers: { Origin: f.origin } });
  t.after(() => ws.terminate());
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await sleep(500);
  assert.deepEqual(await sessions(f), [], 'no PTY or zmx session exists before resume negotiation');
  await until(() => ws.readyState === WebSocket.CLOSED, 6000);
  assert.deepEqual(await sessions(f), []);
});
