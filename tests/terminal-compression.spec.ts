import { test, expect as baseExpect, type Page, type WebSocketRoute } from '@playwright/test';
import { gzipSync } from 'node:zlib';
// @ts-expect-error This JavaScript fixture drives the real native server.
import { fixture } from './network-helper.mjs';

const expect = baseExpect.configure({ timeout: 5000 });
const attachment = '3'.repeat(32), replacement = '4'.repeat(32);
let machine: any;
test.beforeAll(async () => { machine = await fixture(); });
test.afterAll(async () => { await machine?.close(); });

function frame(sequence: number, value: string | Buffer, codec = 1, advertised?: number): Buffer {
  const raw = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const body = codec === 1 ? gzipSync(raw) : raw;
  const bytes = Buffer.alloc(13 + body.length);
  bytes.writeBigUInt64BE(BigInt(sequence)); bytes[8] = codec;
  bytes.writeUInt32BE(advertised ?? raw.length, 9); body.copy(bytes, 13);
  return bytes;
}
function legacyFrame(sequence: number, text: string): Buffer {
  const bytes = Buffer.alloc(8 + Buffer.byteLength(text));
  bytes.writeBigUInt64BE(BigInt(sequence)); bytes.write(text, 8); return bytes;
}
function start(ws: WebSocketRoute, options: { encoding?: string; id?: string; sequence?: number; resumed?: boolean } = {}) {
  ws.send(JSON.stringify({ type: 'resume', attachment: options.id ?? attachment,
    sequence: options.sequence ?? 0, resumed: options.resumed ?? false, encoding: options.encoding }));
}
function state(ws: WebSocketRoute, sequence: number, cols = 40, rows = 24, mode = 'control') {
  ws.send(JSON.stringify({ type: 'state', sequence, mode, cols, rows }));
}
const ready = (ws: WebSocketRoute) => ws.send(JSON.stringify({ type: 'ready' }));

async function terminal(page: Page, connected: (ws: WebSocketRoute, count: number) => void) {
  const sockets: WebSocketRoute[] = [], hellos: any[] = [], input: string[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/assets/index-*.js', async route => {
    const response = await route.fetch(), source = await response.text(), anchor = 'this.output=new';
    expect(source.split(anchor)).toHaveLength(2);
    await route.fulfill({ response, body: source.replace(anchor, 'window.compressionPane=this,' + anchor) });
  });
  await page.routeWebSocket(/\/api\/v1\/terminal\//, ws => {
    const count = sockets.push(ws);
    ws.onMessage(data => {
      if (Buffer.isBuffer(data)) { input.push(data.toString()); return; }
      const message = JSON.parse(data);
      if (message.type === 'resume') { hellos.push(message); connected(ws, count); }
    });
  });
  await page.goto(machine.origin);
  const pane = page.locator('.terminal-pane:not([hidden])');
  const buffer = () => page.evaluate(() => {
    const terminal = (window as any).compressionPane.terminal, active = terminal.buffer.active;
    return Array.from({ length: active.length }, (_, row) => active.getLine(row)?.translateToString(true) ?? '').join('\n');
  });
  const checkpoint = () => page.evaluate(() => (window as any).compressionPane.attachment?.sequence);
  return { sockets, hellos, input, errors, pane, buffer, checkpoint };
}

// Delay actual decompression output, without replacing its gzip validation or payload bytes.
async function delayInflation(page: Page) {
  await page.addInitScript(() => {
    const Native = DecompressionStream;
    const probe = (window as any).inflationProbe = { delayNext: 0, started: 0, settled: 0, releases: [] as Array<() => void> };
    window.DecompressionStream = class {
      readable: ReadableStream<Uint8Array>;
      writable: WritableStream<BufferSource>;
      constructor(format: CompressionFormat) {
        const stream = new Native(format); this.writable = stream.writable;
        let delayed = false;
        this.readable = stream.readable.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          async transform(bytes, controller) {
            if (!delayed && probe.delayNext > 0) {
              delayed = true; probe.delayNext--; probe.started++;
              await new Promise<void>(resolve => { probe.releases.push(resolve); });
              try { controller.enqueue(bytes); } finally { probe.settled++; }
            } else controller.enqueue(bytes);
          },
        }));
      }
    } as unknown as typeof DecompressionStream;
  });
}

async function holdNext(page: Page) {
  await page.evaluate(() => { (window as any).inflationProbe.delayNext = 1; });
}
async function releaseInflation(page: Page) {
  await page.evaluate(() => {
    for (const release of (window as any).inflationProbe.releases.splice(0)) release();
  });
}

test('gzip restores split Unicode before ordered geometry and ready', async ({ page }) => {
  const character = Buffer.from('\u754c');
  const t = await terminal(page, ws => {
    start(ws, { encoding: 'gzip-v1' }); state(ws, 1, 40, 24, 'observe');
    ws.send(frame(2, Buffer.concat([Buffer.from('caf\u00e9 e\u0301 \ud83d\ude80 '), character.subarray(0, 2)])));
    ws.send(frame(3, Buffer.concat([character.subarray(2), Buffer.from('\u001b[?2004h\u001b[?1h\u001b[?1049h\u001b[2J\u001b[H')]), 0));
    state(ws, 4, 20, 10, 'observe'); ws.send(frame(5, 'ABCDEFGHIJKLMNOPQRSTZ'));
    state(ws, 6, 30, 10, 'observe'); ws.send(frame(7, '\u001b[H*', 0)); ready(ws);
  });
  await expect.poll(() => t.hellos[0]).toEqual({ type: 'resume', encoding: 'gzip-v1' });
  await expect(t.pane.locator('.xterm-rows > div').first()).toHaveText('*BCDEFGHIJKLMNOPQRST');
  await expect(t.pane.locator('.xterm-rows > div').nth(1)).toHaveText('Z');
  const result = await page.evaluate(() => {
    const pane = (window as any).compressionPane, terminal = pane.terminal;
    return { normal: terminal.buffer.normal.getLine(0).translateToString(true),
      cols: terminal.cols, rows: terminal.rows, ready: pane.ready,
      applicationCursor: terminal.modes.applicationCursorKeysMode, bracketedPaste: terminal.modes.bracketedPasteMode };
  });
  expect(result).toEqual({ normal: 'caf\u00e9 e\u0301 \ud83d\ude80 \u754c', cols: 30, rows: 10, ready: true, applicationCursor: true, bracketedPaste: true });
  expect(await t.checkpoint()).toBe(7); expect(t.errors).toEqual([]);
});

test('gzip decoding holds later geometry and ready without advancing a parsed checkpoint', async ({ page }) => {
  await delayInflation(page);
  const t = await terminal(page, ws => {
    start(ws, { encoding: 'gzip-v1' }); state(ws, 1); ws.send(frame(2, 'initial output', 0));
  });
  await expect(t.pane.locator('.xterm-rows')).toContainText('initial output');
  await expect.poll(t.checkpoint).toBe(2); await holdNext(page);
  t.sockets[0].send(frame(3, '\u001b[2J\u001b[Hdecoded output'));
  state(t.sockets[0], 4, 20, 10); t.sockets[0].send(frame(5, ' after barrier', 0)); ready(t.sockets[0]);
  await expect.poll(() => page.evaluate(() => (window as any).inflationProbe.started)).toBe(1);
  expect(await page.evaluate(() => {
    const pane = (window as any).compressionPane;
    return { sequence: pane.attachment.sequence, cols: pane.terminal.cols, rows: pane.terminal.rows, ready: pane.ready };
  })).toEqual({ sequence: 2, cols: 40, rows: 24, ready: false });
  await t.pane.getByRole('button', { name: 'Tab', exact: true }).click(); expect(t.input).toEqual([]);
  await releaseInflation(page);
  await expect(t.pane.locator('.xterm-rows')).toContainText('after barrier');
  await expect(t.pane).toHaveAttribute('data-mode', 'control'); await expect.poll(t.checkpoint).toBe(5);
  await t.pane.getByRole('button', { name: 'Tab', exact: true }).click(); await expect.poll(() => t.input).toEqual(['\t']);
  expect(t.errors).toEqual([]);
});

test('socket loss fences in-flight gzip output and resumes from the last parsed checkpoint', async ({ page }) => {
  await delayInflation(page);
  const t = await terminal(page, (ws, count) => {
    start(ws, { encoding: 'gzip-v1', sequence: count === 1 ? 0 : 2, resumed: count !== 1 });
    if (count === 1) { state(ws, 1); ws.send(frame(2, 'initial output', 0)); }
    else { ws.send(frame(3, '\r\nreplayed once')); state(ws, 4, 30, 10); ws.send(frame(5, ' after reconnect', 0)); }
    ready(ws);
  });
  await expect(t.pane.locator('.xterm-rows')).toContainText('initial output'); await holdNext(page);
  t.sockets[0].send(frame(3, '\r\nstale decoded output'));
  state(t.sockets[0], 4, 20, 10); t.sockets[0].send(frame(5, ' stale queued output', 0));
  await expect.poll(() => page.evaluate(() => (window as any).inflationProbe.started)).toBe(1);
  expect(await t.checkpoint()).toBe(2);
  t.sockets[0].close(); await expect(t.pane).toHaveAttribute('data-mode', 'disconnected');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(t.pane.locator('.xterm-rows')).toContainText('after reconnect');
  expect(t.hellos[1]).toEqual({ type: 'resume', attachment, sequence: 2, encoding: 'gzip-v1' });
  await releaseInflation(page);
  await expect.poll(() => page.evaluate(() => (window as any).inflationProbe.settled)).toBe(1);
  expect(await t.buffer()).not.toContain('stale'); expect((await t.buffer()).split('replayed once')).toHaveLength(2);
  expect(await t.checkpoint()).toBe(5);
  expect(await page.evaluate(() => (window as any).compressionPane.terminal.cols)).toBe(30);
  expect(t.errors).toEqual([]);
});

test('disposal cancels an in-flight gzip decode without applying its bytes', async ({ page }) => {
  await delayInflation(page);
  const t = await terminal(page, ws => {
    start(ws, { encoding: 'gzip-v1' }); state(ws, 1); ws.send(frame(2, 'initial output', 0)); ready(ws);
  });
  await expect(t.pane.locator('.xterm-rows')).toContainText('initial output'); await holdNext(page);
  t.sockets[0].send(frame(3, ' discarded output'));
  await expect.poll(() => page.evaluate(() => (window as any).inflationProbe.started)).toBe(1);
  await page.evaluate(() => { (window as any).compressionPane.dispose(); });
  await releaseInflation(page);
  await expect.poll(() => page.evaluate(() => (window as any).inflationProbe.settled)).toBe(1);
  expect(await t.checkpoint()).toBe(2); await expect(t.pane).toHaveCount(0); expect(t.errors).toEqual([]);
});

for (const noSupport of [false, true]) {
  test(noSupport ? 'a browser without gzip support omits encoding and keeps legacy resume frames' : 'an older server can decline compression and retain legacy resume frames', async ({ page }) => {
    if (noSupport) await page.addInitScript(() => { Object.defineProperty(window, 'DecompressionStream', { configurable: true, value: undefined }); });
    const t = await terminal(page, ws => {
      start(ws); state(ws, 1); ws.send(legacyFrame(2, 'compatible raw output')); ready(ws);
    });
    await expect(t.pane.locator('.xterm-rows')).toContainText('compatible raw output');
    expect(t.hellos[0]).toEqual(noSupport ? { type: 'resume' } : { type: 'resume', encoding: 'gzip-v1' });
    expect(await t.checkpoint()).toBe(2); expect(t.errors).toEqual([]);
  });
}

const invalidFrames: Array<[string, () => Buffer]> = [
  ['unknown codec', () => frame(3, 'invalid', 2)],
  ['oversized decoded length', () => frame(3, 'invalid', 1, 65537)],
  ['oversized wire frame', () => frame(3, Buffer.alloc(65537), 0, 65536)],
  ['short header', () => frame(3, 'invalid').subarray(0, 12)],
  ['raw length mismatch', () => frame(3, 'invalid', 0, 3)],
  ['gzip decoded length overflow', () => frame(3, 'x'.repeat(65536), 1, 1)],
  ['gzip decoded length underflow', () => frame(3, 'short', 1, 10)],
  ['corrupt gzip checksum', () => { const bytes = frame(3, 'invalid'); bytes[bytes.length - 8] ^= 255; return bytes; }],
];
for (const [name, invalid] of invalidFrames) {
  test(`malformed compressed transport resets safely: ${name}`, async ({ page }) => {
    const t = await terminal(page, (ws, count) => {
      start(ws, { encoding: 'gzip-v1', id: count === 1 ? attachment : replacement });
      state(ws, 1); ws.send(frame(2, count === 1 ? 'initial output' : 'fresh correct output', 0)); ready(ws);
    });
    await expect(t.pane.locator('.xterm-rows')).toContainText('initial output'); t.sockets[0].send(invalid());
    await expect(t.pane.locator('.xterm-rows')).toContainText('fresh correct output');
    expect(t.hellos[1]).toEqual({ type: 'resume', encoding: 'gzip-v1' });
    expect(await t.checkpoint()).toBe(2); expect(t.errors).toEqual([]);
  });
}

test('an unknown or unrequested acknowledgement encoding forces a fresh attachment', async ({ page }) => {
  const t = await terminal(page, (ws, count) => {
    start(ws, { encoding: count === 1 ? 'future-codec' : 'gzip-v1', id: count === 1 ? attachment : replacement });
    state(ws, 1); ws.send(frame(2, count === 1 ? 'invalid encoding output' : 'fresh correct output', 0)); ready(ws);
  });
  await expect(t.pane.locator('.xterm-rows')).toContainText('fresh correct output');
  expect(t.hellos).toHaveLength(2); expect(t.hellos[1]).toEqual({ type: 'resume', encoding: 'gzip-v1' });
  expect(await t.buffer()).not.toContain('invalid encoding'); expect(t.errors).toEqual([]);
});
