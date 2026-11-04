import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import WebSocket from 'ws';
import { fixture, until, sleep } from './network-helper.mjs';

const exec = promisify(execFile);
const finalMarker = '__COMPRESSED_CURRENT_SCREEN__';
const restoreEnd = '\x1b]1337;EmachineRestore=end\x07';
const unicode = 'caf\u00e9 e\u0301 \u6f22\u5b57 \ud83d\ude80';
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

async function session(f) {
  const { stdout } = await exec('/usr/bin/zmx', ['list'], { env: f.env, timeout: 5000 });
  const match = stdout.match(/name=alpha\tpid=(\d+)\tclients=(\d+)/);
  assert.ok(match, 'The fixture session must exist.');
  return { pid: Number(match[1]), clients: Number(match[2]) };
}

async function printFixtureOutput(f, text) {
  // Stock zmx can close a short-lived Print connection before reading a large
  // IPC message. Small writes avoid that fixture issue; assertions compare the
  // complete combined stream, including UTF-8 boundaries.
  let chunk = '', length = 0;
  const flush = async () => {
    await exec('/usr/bin/zmx', ['print', 'alpha', chunk], { env: f.env, timeout: 5000 });
    chunk = ''; length = 0;
  };
  for (const character of text) {
    const bytes = Buffer.byteLength(character);
    if (length + bytes > 2048) await flush();
    chunk += character; length += bytes;
  }
  if (chunk) await flush();
}

async function connect(f, path, { encoding, checkpoint } = {}) {
  const ws = new WebSocket(f.origin.replace('http', 'ws') + '/' + path + '&resume=1', {
    headers: { Origin: f.origin }, maxPayload: 8 * 1024 * 1024,
  });
  const packets = [], events = [], violations = [], output = [];
  let header, sequence = 0, ready = false, tail = '', binaryBytes = 0;
  ws.on('error', error => { violations.push(error.message); });
  ws.on('message', (data, binary) => {
    try {
      if (!binary) {
        const packet = JSON.parse(data.toString());
        packets.push(packet);
        if (packet.type === 'resume') {
          assert.equal(header, undefined, 'Negotiate once per socket.');
          header = packet; sequence = packet.sequence;
          assert.ok(packet.encoding === undefined || packet.encoding === 'gzip-v1');
        } else if (packet.type === 'state') {
          assert.ok(header, 'State must follow resume negotiation.');
          assert.equal(packet.sequence, sequence + 1);
          sequence = packet.sequence; events.push({ sequence, state: packet });
        } else if (packet.type === 'ready') ready = true;
        else if (packet.type === 'error') violations.push(packet.message);
        return;
      }
      assert.ok(header, 'Output must follow resume negotiation.');
      assert.ok(data.length >= 8);
      const next = Number(data.readBigUInt64BE(0));
      assert.equal(next, sequence + 1, 'Data and geometry must share one sequence.');
      sequence = next; binaryBytes += data.length;
      let bytes = Buffer.from(data.subarray(8)), codec;
      if (header.encoding === 'gzip-v1') {
        assert.ok(data.length >= 13, 'Negotiated output needs its complete envelope.');
        codec = data[8];
        const length = data.readUInt32BE(9);
        assert.ok(length >= 1 && length <= 65536, 'The decoded frame must be bounded.');
        const payload = data.subarray(13);
        if (codec === 0) {
          assert.equal(payload.length, length);
          bytes = Buffer.from(payload);
        } else {
          assert.equal(codec, 1, 'Only raw and independent gzip members are defined.');
          assert.ok(length >= 1024, 'Small interactive output should remain raw.');
          assert.ok(payload.length <= length - 64, 'Compression must save enough bytes.');
          bytes = gunzipSync(payload, { maxOutputLength: 65536 });
          assert.equal(bytes.length, length, 'The declared decoded length must match.');
        }
      }
      output.push(bytes);
      events.push({ sequence, codec, data: bytes });
      tail = (tail + bytes.toString('utf8')).slice(-65536);
      if (bytes.includes(Buffer.from('\x1b[c'))) ws.send(Buffer.from('\x1b[?1;2c'));
      if (bytes.includes(Buffer.from('\x1b[6n'))) ws.send(Buffer.from('\x1b[1;1R'));
    } catch (error) { violations.push(error.message); }
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ type: 'resume', ...checkpoint, ...(encoding ? { encoding } : {}) }));
  return {
    ws, packets, events, violations,
    get header() { return header; }, get tail() { return tail; },
    get bytes() { return Buffer.concat(output); }, get binaryBytes() { return binaryBytes; },
    checkpoint() { return { attachment: header.attachment, sequence }; },
    async ready() {
      await until(() => ready && header);
      assert.deepEqual(violations, [], 'Terminal frames must be ordered and decodable.');
      return header;
    },
    async restored() {
      await until(() => tail.includes(finalMarker) && tail.includes(restoreEnd));
      assert.deepEqual(violations, [], 'The complete history must decode without errors.');
      return Buffer.concat(output);
    },
    async close() {
      if (ws.readyState === WebSocket.CLOSED) return;
      const done = new Promise(resolve => ws.once('close', resolve));
      ws.close(); const timer = setTimeout(() => ws.terminate(), 1000);
      try { await done; } finally { clearTimeout(timer); }
    },
  };
}

async function setup(t) {
  const f = await fixture(), clients = [];
  t.after(async () => { for (const client of clients) await client.close(); await f.close(); });
  const project = (await f.state()).projects.find(project => project.name === 'alpha');
  const path = 'api/v1/terminal/' + project.id + '?cols=100&rows=30';
  return {
    f, path,
    async connect(options) {
      const client = await connect(f, path, options); clients.push(client); return client;
    },
  };
}

async function seedHistory(t, f) {
  const script = join(f.home, 'compression-history.py');
  const body = '\x1b[1;38;2;220;180;120m' + 'styled '.repeat(3) +
    '\x1b[22;38;2;100;200;240m' + unicode + ' ' +
    '\x1b[4;38;2;160;220;140m' + 'underlined ' +
    '\x1b[24;38;2;220;130;190m' + 'detail '.repeat(3);
  await writeFile(script, [
    'import sys, time',
    'for i in range(10000):',
    "    sys.stdout.write('HIST_%05d ' % i + " + JSON.stringify(body) + " + '\\x1b[0m\\r\\n')",
    "sys.stdout.write('\\x1b[?1h\\x1b[?2004h\\x1b[?25l\\x1b[30;1H" + finalMarker + "\\x1b[30;24H')",
    'sys.stdout.flush()',
    'while True: time.sleep(1)',
    '',
  ].join('\n'));
  const env = { ...f.env, PATH: process.env.PATH, TERM: 'xterm-256color' };
  delete env.ZMX_NO_DETACH_KEY;
  const manual = spawn('script', ['--quiet', '--return', '--command',
    'stty cols 100 rows 30; exec /usr/bin/zmx attach alpha python3 -u ' + quote(script), '/dev/null'], {
    cwd: f.home, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (manual.exitCode === null && manual.signalCode === null) {
      manual.stdin.end('\x1c');
      await Promise.race([new Promise(resolve => manual.once('close', resolve)), sleep(2000)]);
      if (manual.exitCode === null && manual.signalCode === null) manual.kill('SIGTERM');
    }
  });
  let tail = '';
  const collect = bytes => { tail = (tail + bytes.toString()).slice(-65536); };
  manual.stdout.on('data', collect); manual.stderr.on('data', collect);
  await until(() => tail.includes(finalMarker));
}

test('terminal compression preserves complete styled history while reducing cold-attach wire bytes', { timeout: 20000 }, async t => {
  const fixture = await setup(t);
  await seedHistory(t, fixture.f);
  const history = () => exec('/usr/bin/zmx', ['history', 'alpha'], {
    env: fixture.f.env, timeout: 5000, maxBuffer: 8 * 1024 * 1024,
  }).then(result => result.stdout);
  const originalHistory = await history(), original = await session(fixture.f);
  const raw = await fixture.connect();
  assert.equal((await raw.ready()).encoding, undefined, 'An older client keeps the original wire format.');
  const rawBytes = await raw.restored();
  await raw.close();
  const compressed = await fixture.connect({ encoding: 'gzip-v1' });
  const header = await compressed.ready();
  assert.equal(header.encoding, 'gzip-v1', 'The server must acknowledge requested lossless compression.');
  const decoded = await compressed.restored();
  assert.deepEqual(decoded, rawBytes, 'Compression must preserve every terminal byte, including cursor and modes.');
  const ids = [...decoded.toString('utf8').matchAll(/HIST_(\d{5})/g)].map(match => Number(match[1]));
  assert.deepEqual(ids, Array.from({ length: 10000 }, (_, index) => index), 'Every history row must survive once and in order.');
  assert.ok(decoded.includes(Buffer.from(unicode)), 'Unicode bytes must survive packet boundaries.');
  assert.ok(compressed.events.some(event => event.codec === 1), 'The history must use compressed frames.');
  assert.ok(compressed.binaryBytes < raw.binaryBytes / 3,
    'The representative full history must require less than one third of the raw wire bytes.');
  assert.equal(await history(), originalHistory, 'Neither attachment may trim daemon history.');
  assert.equal((await session(fixture.f)).pid, original.pid, 'The manual zmx daemon must remain alive.');
});

test('terminal compression keeps tiny output raw and renegotiates encoding on warm resume', { timeout: 20000 }, async t => {
  const fixture = await setup(t);
  const first = await fixture.connect({ encoding: 'gzip-v1' });
  assert.equal((await first.ready()).encoding, 'gzip-v1');
  await until(() => first.tail.includes('fixture>'));
  const original = await session(fixture.f);
  const tiny = '__SMALL_COMPRESSED_TERMINAL_FRAME__';
  await exec('/usr/bin/zmx', ['print', 'alpha', tiny + '\r\n'], { env: fixture.f.env, timeout: 5000 });
  await until(() => first.tail.includes(tiny));
  const small = first.events.find(event => event.data?.includes(Buffer.from(tiny)));
  assert.equal(small.codec, 0, 'Interactive output must not wait for compression.');
  const checkpoint = first.checkpoint();
  await first.close();

  const gap = '__RAW_RESUME_GAP__ ' + unicode + ' ' + 'rich-gap '.repeat(600) + '\r\n';
  await printFixtureOutput(fixture.f, gap);
  const raw = await fixture.connect({ checkpoint });
  const rawHeader = await raw.ready();
  assert.equal(rawHeader.resumed, true); assert.equal(rawHeader.attachment, checkpoint.attachment);
  assert.equal(rawHeader.encoding, undefined, 'A lease must not force the previous socket encoding.');
  await until(() => raw.bytes.includes(Buffer.from(gap)));
  assert.ok(raw.bytes.includes(Buffer.from(gap)), 'The older client must receive the complete missed bytes.');
  assert.ok(raw.events.filter(event => event.data).every(event => event.codec === undefined));
  const rawCheckpoint = raw.checkpoint();
  await raw.close();

  const compressedGap = '__GZIP_RESUME_GAP__ ' + unicode + ' ' + 'compressed-gap '.repeat(500) + '\r\n';
  await printFixtureOutput(fixture.f, compressedGap);
  const next = await fixture.connect({ encoding: 'gzip-v1', checkpoint: rawCheckpoint });
  const nextHeader = await next.ready();
  assert.equal(nextHeader.resumed, true); assert.equal(nextHeader.attachment, checkpoint.attachment);
  assert.equal(nextHeader.encoding, 'gzip-v1');
  await until(() => next.bytes.includes(Buffer.from(compressedGap)));
  assert.ok(next.events.some(event => event.codec === 1), 'Replayed output must be encoded for its current socket.');
  assert.equal(next.bytes.includes(Buffer.from(tiny)), false, 'Acknowledged history must not be replayed.');
  assert.deepEqual(next.violations, []);
  const current = await session(fixture.f);
  assert.equal(current.pid, original.pid); assert.equal(current.clients, 1);
});

test('unknown terminal compression requests fall back to the original format', { timeout: 15000 }, async t => {
  const fixture = await setup(t);
  const client = await fixture.connect({ encoding: 'future-codec' });
  assert.equal((await client.ready()).encoding, undefined);
  const marker = '__UNSUPPORTED_ENCODING_RAW__';
  await exec('/usr/bin/zmx', ['print', 'alpha', marker + '\r\n'], { env: fixture.f.env, timeout: 5000 });
  await until(() => client.tail.includes(marker));
  assert.ok(client.events.filter(event => event.data).every(event => event.codec === undefined));
  assert.deepEqual(client.violations, []);
});
