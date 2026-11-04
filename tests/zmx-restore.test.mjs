import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zmxExecutable } from '../scripts/zmx.mjs';

const boundary = '\x1b[2J\x1b[H\x1b[0m';
const begin = '\x1b]1337;EmachineRestore=begin\x07\x1b[?2026h';
const end = '\x1b[?2026l\x1b]1337;EmachineRestore=end\x07';
const clear = '\x1b[2J\x1b[H';
const prelude = '\x1b]2;live before Init\x07';
const snapshot = '\x1b[38;2;1;2;3mhistory caf\u00e9 \u754c\x1b[0m' + boundary + 'SNAPSHOT_SCREEN\x1b[?1h\x1b[3;5H';
const later = 'application output' + boundary + 'AFTER_INITIALIZATION\x1b[2;4H';
const wrapped = payload => {
  const offset = payload.indexOf(boundary);
  return begin + payload.slice(0, offset) + '\r\n'.repeat(3) + payload.slice(offset) + end;
};

// The pinned Linux x86-64/ARM64 protocol uses an eight-byte packed header:
// one tag byte, a little-endian u32 length, and three trailing padding bytes.
function message(tag, payload = '') {
  const bytes = Buffer.from(payload);
  const header = Buffer.alloc(8);
  header[0] = tag;
  header.writeUInt32LE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
}

async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for the isolated zmx client');
}

async function client(t, { initial, after = later, sync = true, resizeLength = 8 }) {
  const directory = await mkdtemp(join(tmpdir(), 'emachine-zmx-restore-'));
  const peers = new Set();
  const requests = [];
  let child, closed, output = '', error = '', initialized = false;
  const server = createServer(peer => {
    peers.add(peer);
    peer.on('close', () => peers.delete(peer));
    peer.on('error', () => {});
    let buffer = Buffer.alloc(0);
    peer.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 8) {
        const length = buffer.readUInt32LE(1);
        if (length > 1024 * 1024) { peer.destroy(); return; }
        if (buffer.length < 8 + length) return;
        const tag = buffer[0];
        buffer = buffer.subarray(8 + length);
        requests.push({ tag, length });
        if (tag === 7 && length === resizeLength && !initialized) {
          initialized = true;
          // A real daemon may queue these live bytes before handling Init.
          for (const payload of initial) peer.write(message(1, payload));
          if (!sync) peer.write(message(1, after));
        } else if (tag === 6 && initialized) {
          // The client only needs the ordered reply, not the Info payload ABI.
          peer.write(message(6, Buffer.from([0])));
          peer.write(message(1, after));
        } else if (tag === 3) peer.end();
      }
    });
  });
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      const term = setTimeout(() => child.kill('SIGTERM'), 1000);
      const kill = setTimeout(() => child.kill('SIGKILL'), 2000);
      try { await closed; } finally { clearTimeout(term); clearTimeout(kill); }
    }
    for (const peer of peers) peer.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(join(directory, 'fixture'), resolve);
  });
  const env = { ...process.env, ZMX_DIR: directory, ZMX_SYNC_RESTORE: sync ? '1' : '0', ZMX_RESTORE_ROWS: '3' };
  delete env.ZMX_SESSION; delete env.ZMX_SESSION_PREFIX;
  child = spawn(zmxExecutable, ['attach', 'fixture'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  closed = new Promise(resolve => child.once('close', resolve));
  child.on('error', value => { error += value.message; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { error += data.toString(); });
  return {
    requests,
    get output() { return output; },
    async until(text) {
      await waitFor(() => {
        assert.equal(error, '', 'the isolated zmx client must start cleanly');
        return output.includes(text);
      });
    },
  };
}

for (const resizeLength of [8, 4]) {
  test(`zmx restores a snapshot after live output with ${resizeLength}-byte Init`, { timeout: 7000 }, async t => {
    const c = await client(t, { initial: [prelude, snapshot], resizeLength });
    await c.until('SNAPSHOT_SCREEN');
    assert.equal(c.output.startsWith(clear + prelude + wrapped(snapshot)), true,
      'live output must not consume the initial snapshot recognition');
    await c.until('AFTER_INITIALIZATION');
    assert.equal(c.output, clear + prelude + wrapped(snapshot) + later,
      'history, Unicode, cursor/modes, and later output remain ordered and byte-exact');
    const info = c.requests.findIndex(request => request.tag === 6);
    assert.ok(info > c.requests.findLastIndex(request => request.tag === 7),
      'the read-only barrier follows both compatible Init encodings');
  });
}

test('zmx stops restore recognition at the Init barrier when no snapshot arrives', { timeout: 7000 }, async t => {
  const c = await client(t, { initial: [] });
  await c.until('AFTER_INITIALIZATION');
  assert.equal(c.output, clear + later, 'later application output must not be classified as an initial restore');
});

test('zmx preserves application-owned synchronized output during initialization', { timeout: 7000 }, async t => {
  const owned = '\x1b[?2026h' + snapshot + '\x1b[?2026l';
  const c = await client(t, { initial: [prelude, owned] });
  await c.until('AFTER_INITIALIZATION');
  assert.equal(c.output, clear + prelude + owned + later);
});

for (const parts of [['\x1b[?2026h'], ['\x1b[?20', '26h']]) {
  test(`zmx preserves synchronization started in ${parts.length} earlier live frames`, { timeout: 7000 }, async t => {
    const after = '\x1b[?2026l' + later;
    const c = await client(t, { initial: [...parts, snapshot], after });
    await c.until('AFTER_INITIALIZATION');
    assert.equal(c.output, clear + parts.join('') + snapshot + after,
      'the restore wrapper must not take over an application-owned synchronized update');
  });
}

test('zmx keeps the ordinary client protocol and output unchanged without opt-in', { timeout: 7000 }, async t => {
  const c = await client(t, { initial: [prelude, snapshot], sync: false });
  await c.until('AFTER_INITIALIZATION');
  assert.equal(c.output, clear + prelude + snapshot + later);
  assert.equal(c.requests.some(request => request.tag === 6), false);
});
