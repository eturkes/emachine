import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';
// @ts-expect-error This JavaScript fixture drives the real native server.
import { fixture } from './network-helper.mjs';

let machine: any;
test.beforeAll(async () => { machine = await fixture(); });
test.afterAll(async () => { await machine?.close(); });
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const attachment = '1'.repeat(32);
function frame(sequence: number, text: string | Buffer): Buffer {
  const data = Buffer.isBuffer(text) ? text : Buffer.from(text);
  const result = Buffer.alloc(8 + data.length);
  result.writeBigUInt64BE(BigInt(sequence)); data.copy(result, 8);
  return result;
}

async function terminal(page: Page, connected: (ws: WebSocketRoute, count: number) => void) {
  const messages: Array<{ connection: number; message: any }> = [];
  const input: string[] = [];
  const sockets: WebSocketRoute[] = [];
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'iPhone' });
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 });
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' });
  });
  await page.routeWebSocket(/\/api\/v1\/terminal\//, ws => {
    const count = sockets.push(ws);
    ws.onMessage(data => {
      if (Buffer.isBuffer(data)) input.push(data.toString());
      else {
        try { messages.push({ connection: count, message: JSON.parse(data) }); } catch { /* Ignore non-control input. */ }
      }
    });
    connected(ws, count);
  });
  await page.goto(machine.origin);
  const pane = page.locator('.terminal-pane:not([hidden])');
  const snapshot = async () => {
    await pane.getByRole('button', { name: 'Copy', exact: true }).tap();
    const dialog = pane.getByRole('dialog', { name: 'Copy terminal output', exact: true });
    await expect(dialog).toBeVisible();
    const text = await dialog.getByRole('textbox', { name: 'Terminal output', exact: true }).inputValue();
    await dialog.getByRole('button', { name: 'Close output', exact: true }).tap();
    return text;
  };
  const reconnect = async () => {
    const count = sockets.length;
    sockets.at(-1)!.close();
    await expect(pane).toHaveAttribute('data-mode', 'disconnected');
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => sockets.length).toBeGreaterThan(count);
  };
  return { pane, snapshot, reconnect, input, messages, sockets };
}

function start(ws: WebSocketRoute, mode = 'observe') {
  ws.send(JSON.stringify({ type: 'resume', attachment, sequence: 0, resumed: false }));
  ws.send(JSON.stringify({ type: 'state', sequence: 1, mode, session: 'resume-output', cols: 40, rows: 24 }));
}
const ready = (ws: WebSocketRoute) => ws.send(JSON.stringify({ type: 'ready' }));

async function captureSocket(page: Page) {
  await page.route('**/assets/index-*.js', async route => {
    const response = await route.fetch();
    const source = await response.text(), anchor = 'this.output=new';
    expect(source.split(anchor)).toHaveLength(2);
    // Capture the real pane in this test response without adding a production test API.
    await route.fulfill({ response, body: source.replace(anchor, 'window.resumePane=this,' + anchor) });
  });
}

test('warm reconnect retains native scrollback and appends missed output exactly once', async ({ page }) => {
  const history = Array.from({ length: 80 }, (_, index) => 'retained row ' + String(index).padStart(3, '0')).join('\r\n');
  const t = await terminal(page, (ws, count) => {
    if (count === 1) {
      start(ws);
      ws.send(frame(2, '\u001b[2J\u001b[H' + history));
    } else {
      ws.send(JSON.stringify({ type: 'resume', attachment, sequence: 2, resumed: true }));
      ws.send(frame(3, '\r\noutput during disconnect'));
      ws.send(JSON.stringify({ type: 'state', sequence: 4, mode: 'observe', cols: 40, rows: 24 }));
    }
    ready(ws);
  });
  await expect(t.pane.locator('.xterm-rows')).toContainText('retained row 079');
  await t.reconnect();
  await expect(t.pane.locator('.xterm-rows')).toContainText('output during disconnect');
  expect(await t.snapshot()).toBe(history.replaceAll('\r\n', '\n') + '\noutput during disconnect');
  expect(t.messages.filter(item => item.message.type === 'resume')).toEqual([
    { connection: 1, message: { type: 'resume' } },
    { connection: 2, message: { type: 'resume', attachment, sequence: 2 } },
  ]);
  expect(t.input).toEqual([]);
});

test('user input stays disabled until replay is parsed and ready without replaying dropped keys', async ({ page }) => {
  const t = await terminal(page, ws => {
    start(ws, 'control');
    ws.send(frame(2, '\u001b[2J\u001b[Hrestoring terminal'));
  });
  await expect(t.pane.locator('.xterm-rows')).toContainText('restoring terminal');
  const tab = t.pane.getByRole('button', { name: 'Tab', exact: true });
  await tab.tap();
  expect(t.input).toEqual([]);
  ready(t.sockets[0]);
  await expect(t.pane).toHaveAttribute('data-mode', 'control');
  await tab.tap();
  await expect.poll(() => t.input.join('')).toBe('\t');
});

test('replay answers parser queries after ready while dropping typed and pasted input', async ({ page }) => {
  const t = await terminal(page, ws => {
    start(ws, 'control');
    ws.send(frame(2, '\u001b[2J\u001b[H\u001b[c\u001b[6n\u001b[?2004$p\u001b]10;?\u0007\u001bP$qm\u001b\\queries parsed'));
  });
  await expect(t.pane.locator('.xterm-rows')).toContainText('queries parsed');
  await t.pane.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('discard typed');
  await t.pane.locator('.xterm-helper-textarea').evaluate(element => {
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', '\u001b[?1;2c');
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData }));
  });
  expect(t.input).toEqual([]);
  ready(t.sockets[0]);
  await expect.poll(() => t.input.length).toBe(5);
  expect(t.input.slice(0, 3)).toEqual(['\u001b[?1;2c', '\u001b[1;1R', '\u001b[?2004;2$y']);
  expect(t.input[3]).toMatch(/^\u001b\]10;rgb:/);
  expect(t.input[4]).toBe('\u001bP1$r0m\u001b\\');
});

test('warm reconnect retains split UTF-8, alternate screen, cursor modes and normal scrollback', async ({ page }) => {
  const character = Buffer.from('\u754c');
  const t = await terminal(page, (ws, count) => {
    if (count === 1) {
      start(ws, 'control');
      ws.send(frame(2, Buffer.concat([
        Buffer.from('\u001b[2J\u001b[Hnormal history\u001b[?1049h\u001b[2J\u001b[H\u001b[?1h\u001b[?2004halt '), character.subarray(0, 2),
      ])));
    } else {
      ws.send(JSON.stringify({ type: 'resume', attachment, sequence: 2, resumed: true }));
      ws.send(frame(3, Buffer.concat([character.subarray(2), Buffer.from('e\u0301 \ud83d\ude42\r\nnext')])));
      ws.send(JSON.stringify({ type: 'state', sequence: 4, mode: 'control', cols: 40, rows: 24 }));
    }
    ready(ws);
  });
  await expect(t.pane.locator('.xterm-rows')).toContainText('alt ');
  await t.reconnect();
  await expect(t.pane.locator('.xterm-rows')).toContainText('next');
  expect(await t.snapshot()).toBe('alt \u754ce\u0301 \ud83d\ude42\nnext');
  await t.pane.getByRole('button', { name: '\u2191', exact: true }).tap();
  await expect.poll(() => t.input.join('')).toBe('\u001bOA');
  t.sockets[1].send(frame(5, '\u001b[?1049l'));
  await expect(t.pane.locator('.xterm-rows')).toContainText('normal history');
  expect(await t.snapshot()).toBe('normal history');
});

test('expired resume replaces stale history and legacy servers still reset on reconnect', async ({ page }) => {
  const replacement = '2'.repeat(32);
  const t = await terminal(page, (ws, count) => {
    if (count < 3) {
      ws.send(JSON.stringify({ type: 'resume', attachment: count === 1 ? attachment : replacement, sequence: 0, resumed: false }));
      ws.send(JSON.stringify({ type: 'state', sequence: 1, mode: 'observe', cols: 40, rows: 24 }));
      ws.send(frame(2, count === 1 ? 'stale history' : 'fresh history'));
      ready(ws);
    } else {
      ws.send(JSON.stringify({ type: 'state', mode: 'observe', cols: 40, rows: 24 }));
      ws.send(Buffer.from(count === 3 ? 'legacy history' : 'legacy reconnect'));
    }
  });
  await expect(t.pane.locator('.xterm-rows')).toContainText('stale history');
  await t.reconnect();
  await expect(t.pane.locator('.xterm-rows')).toContainText('fresh history');
  expect(await t.snapshot()).toBe('fresh history');
  await t.reconnect();
  await expect(t.pane.locator('.xterm-rows')).toContainText('legacy history');
  expect(await t.snapshot()).toBe('legacy history');
  await t.reconnect();
  await expect(t.pane.locator('.xterm-rows')).toContainText('legacy reconnect');
  expect(await t.snapshot()).toBe('legacy reconnect');
  expect(t.messages.filter(item => item.message.type === 'resume').map(item => item.message)).toEqual([
    { type: 'resume' }, { type: 'resume', attachment, sequence: 2 },
    { type: 'resume', attachment: replacement, sequence: 2 }, { type: 'resume' },
  ]);
});

test('a missing output sequence forces a fresh restore without parsing the gap', async ({ page }) => {
  const t = await terminal(page, (ws, count) => {
    if (count === 2) {
      ws.send(JSON.stringify({ type: 'resume', attachment, sequence: 2, resumed: true }));
      ws.send(frame(4, 'invalid gap payload'));
    } else {
      start(ws);
      ws.send(frame(2, count === 1 ? 'old connection' : 'recovered connection'));
      ready(ws);
    }
  });
  await expect(t.pane.locator('.xterm-rows')).toContainText('old connection');
  await t.reconnect();
  await expect(t.pane.locator('.xterm-rows')).toContainText('recovered connection');
  expect(await t.snapshot()).toBe('recovered connection');
  expect(t.messages.filter(item => item.message.type === 'resume').at(-1)?.message).toEqual({ type: 'resume' });
});

test('reconnect drains accepted parser bytes and geometry before choosing its checkpoint', async ({ page }) => {
  await captureSocket(page);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const t = await terminal(page, (ws, count) => {
    if (count === 1) {
      start(ws); ws.send(frame(2, 'initial output'));
    } else {
      ws.send(JSON.stringify({ type: 'resume', attachment, sequence: 6, resumed: true }));
      ws.send(frame(7, '\u001b[H*'));
      ws.send(JSON.stringify({ type: 'state', sequence: 8, mode: 'observe', cols: 30, rows: 10 }));
    }
    ready(ws);
  });
  await expect(t.pane.locator('.xterm-rows')).toContainText('initial output');
  const packets = [
    [...frame(3, 'x'.repeat(320 * 1024) + '\u001b[?1049h\u001b[2J\u001b[H')],
    JSON.stringify({ type: 'state', sequence: 4, mode: 'observe', cols: 20, rows: 10 }),
    [...frame(5, 'ABCDEFGHIJKLMNOPQRSTZ')],
    JSON.stringify({ type: 'state', sequence: 6, mode: 'observe', cols: 30, rows: 10 }),
  ];
  await page.evaluate(packets => {
    const socket: WebSocket = (window as any).resumePane.ws;
    // Receive the complete burst and lose the socket in one task, before xterm parses it.
    for (const packet of packets) socket.dispatchEvent(new MessageEvent('message', {
      data: typeof packet === 'string' ? packet : new Uint8Array(packet).buffer,
    }));
    socket.dispatchEvent(new CloseEvent('close'));
    window.dispatchEvent(new Event('online'));
  }, packets);
  await expect.poll(() => t.sockets.length).toBe(2);
  await expect(t.pane.locator('.xterm-rows > div').first()).toHaveText('*BCDEFGHIJKLMNOPQRST');
  await expect(t.pane.locator('.xterm-rows > div').nth(1)).toHaveText('Z');
  await expect(t.pane.locator('.xterm-rows > div')).toHaveCount(10);
  expect(t.messages.filter(item => item.message.type === 'resume').at(-1)?.message).toEqual({ type: 'resume', attachment, sequence: 6 });
  expect(errors).toEqual([]);
});

for (const outcome of ['control', 'observe', 'fresh']) {
  test('never-sent parser replies survive socket loss only for resumed control: ' + outcome, async ({ page }) => {
    await captureSocket(page);
    const t = await terminal(page, (ws, count) => {
      if (count === 1) {
        start(ws, 'control'); ws.send(frame(2, 'initial output'));
      } else {
        const fresh = outcome === 'fresh';
        ws.send(JSON.stringify({ type: 'resume', attachment: fresh ? '2'.repeat(32) : attachment, sequence: fresh ? 0 : 3, resumed: !fresh }));
        if (!fresh) {
          // Losing the transport journals an observer role before single-client control returns.
          ws.send(JSON.stringify({ type: 'state', sequence: 4, mode: 'observe', cols: 40, rows: 24 }));
          ws.send(frame(5, '\u001b[2;3H\u001b[6n'));
        }
        ws.send(JSON.stringify({ type: 'state', sequence: fresh ? 1 : 6, mode: outcome === 'observe' ? 'observe' : 'control', cols: 40, rows: 24 }));
      }
      ready(ws);
    });
    await expect(t.pane.locator('.xterm-rows')).toContainText('initial output');
    await page.evaluate(packet => {
      const socket: WebSocket = (window as any).resumePane.ws;
      socket.dispatchEvent(new MessageEvent('message', { data: new Uint8Array(packet).buffer }));
      socket.dispatchEvent(new CloseEvent('close'));
      window.dispatchEvent(new Event('online'));
    }, [...frame(3, '\u001b[H\u001b[c\u001b[6n')]);
    await expect.poll(() => t.sockets.length).toBe(2);
    await expect(t.pane).toHaveAttribute('data-mode', outcome === 'observe' ? 'observe' : 'control');
    const replies = outcome === 'control' ? ['\u001b[?1;2c', '\u001b[1;1R', '\u001b[2;3R'] : [];
    await expect.poll(() => t.input).toEqual(replies);
    expect(t.messages.filter(item => item.message.type === 'resume').at(-1)?.message).toEqual({ type: 'resume', attachment, sequence: 3 });
  });
}
