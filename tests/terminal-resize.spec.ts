import { test, expect, type Page } from '@playwright/test';
// @ts-expect-error This JavaScript fixture drives the real native server.
import { fixture } from './network-helper.mjs';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
let server: any;
test.beforeAll(async () => { server = await fixture(); });
test.afterAll(async () => { await server?.close(); });

async function dimensions(page: Page) {
  return page.locator('.xterm-rows').evaluate(element => {
    const style = getComputedStyle(element);
    const canvas = document.createElement('canvas').getContext('2d')!;
    canvas.font = `${style.fontSize} ${style.fontFamily}`;
    return { cols: Math.round(element.getBoundingClientRect().width / canvas.measureText('W').width), rows: element.childElementCount };
  });
}

type TerminalPacket = string | { cols: number; rows: number };
declare global { interface Window { terminalStream: { deliver(packets: TerminalPacket[]): void; reconnect(): void } } }

async function queuedTerminal(page: Page) {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    let terminal: WebSocket | undefined;
    let connections = 0;
    class CapturedSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols ?? []);
        if (!new URL(String(url)).pathname.includes('/api/v1/terminal/')) return;
        terminal = this;
        const attachment = ++connections;
        this.addEventListener('message', event => { if (event.isTrusted) event.stopImmediatePropagation(); }, true);
        this.addEventListener('open', () => {
          this.dispatchEvent(new MessageEvent('message', {
            data: JSON.stringify({ type: 'state', mode: 'observe', cols: 40, rows: 20 }),
          }));
          this.dispatchEvent(new MessageEvent('message', {
            data: new TextEncoder().encode(attachment === 1 ? 'READY' : 'Restored question\r\n> Restored choice').buffer,
          }));
        });
      }
    }
    window.WebSocket = CapturedSocket;
    window.terminalStream = {
      deliver(packets) {
        if (!terminal || terminal.readyState !== NativeWebSocket.OPEN) throw new Error('The fixture terminal is not open.');
        // A burst can deliver several packets before xterm's asynchronous parser runs.
        for (const packet of packets) {
          const data = typeof packet === 'string'
            ? new TextEncoder().encode(packet).buffer
            : JSON.stringify({ type: 'state', mode: 'observe', ...packet });
          terminal.dispatchEvent(new MessageEvent('message', { data }));
        }
      },
      reconnect() {
        if (!terminal) throw new Error('The fixture terminal is not open.');
        terminal.dispatchEvent(new CloseEvent('close'));
        window.dispatchEvent(new Event('online'));
      },
    };
  });
  await page.goto(server.origin);
  await expect(page.locator('.xterm-rows')).toContainText('READY');
}

function selectorFrame(width: number, active: number) {
  return ['First option', 'Second option', 'Third option']
    .map((label, index) => `${index === active ? '>' : ' '} ${label}`.padEnd(width - 1, '.'))
    .concat('Use up/down').join('\r\n');
}

test('terminal waits for font metrics before attaching a live session', async ({ page }) => {
  let release!: () => void;
  const fonts = new Promise<void>(resolve => { release = resolve; });
  let pendingFonts = 0;
  const connections: string[] = [];
  await page.route(/jetbrains-mono.*\.woff2$/, async route => { pendingFonts++; await fonts; await route.continue(); });
  await page.routeWebSocket(/\/api\/v1\/terminal\//, ws => { connections.push(ws.url()); });
  try {
    await page.goto(server.origin, { waitUntil: 'domcontentloaded' });
    await expect.poll(() => pendingFonts).toBeGreaterThan(0);
    await expect(page.locator('.terminal-host')).toBeVisible();
    expect(connections).toEqual([]);
  } finally { release(); }
  await expect(page.locator('.xterm-rows > div')).not.toHaveCount(0);
  await expect.poll(() => connections.length).toBe(1);
  const url = new URL(connections[0]);
  expect({ cols: Number(url.searchParams.get('cols')), rows: Number(url.searchParams.get('rows')) }).toEqual(await dimensions(page));
});

test('terminal synchronizes fitted dimensions on control before repainting live output', async ({ page }) => {
  let remote = { cols: 80, rows: 24 };
  let send!: (data: string | Buffer) => void;
  const input: string[] = [];
  const resizes: { cols: number; rows: number }[] = [];
  await page.routeWebSocket(/\/api\/v1\/terminal\//, ws => {
    const url = new URL(ws.url());
    remote = { cols: Number(url.searchParams.get('cols')), rows: Number(url.searchParams.get('rows')) };
    send = data => ws.send(data);
    ws.onMessage(data => {
      if (Buffer.isBuffer(data)) { input.push(data.toString()); return; }
      const message = JSON.parse(data);
      if (message.type === 'resize') {
        remote = { cols: message.cols, rows: message.rows };
        resizes.push(remote);
        send(JSON.stringify({ type: 'state', mode: 'control', ...remote }));
      }
    });
    send(JSON.stringify({ type: 'state', mode: 'control', ...remote }));
    send(Buffer.from('READY\r\n'));
  });
  await page.goto(server.origin);
  await expect(page.locator('.terminal-pane')).toHaveAttribute('data-mode', 'control');
  await expect(page.locator('.xterm-rows')).toContainText('READY');
  const fitted = await dimensions(page);
  await expect.poll(() => remote).toEqual(fitted);
  const count = resizes.length;
  // Full-width in-place redraws wrap incorrectly when the remote and displayed grids differ.
  for (let frame = 0; frame < 12; frame++) {
    const line = `FRAME${String(frame).padStart(2, '0')}`.padEnd(remote.cols, '.');
    send(Buffer.from(`\u001b[H${(line + '\r\n').repeat(remote.rows - 1)}PROMPT>\u001b[J`));
    await expect(page.locator('.xterm-rows > div').first()).toHaveText(line);
    await expect(page.locator('.xterm-rows > div').last()).toHaveText('PROMPT>');
  }
  expect(resizes.length).toBe(count);
  expect(input).toEqual([]);
  // A remote geometry update can differ even though the local grid is already fitted.
  remote = { cols: 100, rows: 30 };
  send(JSON.stringify({ type: 'state', mode: 'control', ...remote }));
  await expect.poll(() => remote).toEqual(fitted);
  await page.setViewportSize({ width: 390, height: 500 });
  await expect.poll(async () => (await dimensions(page)).rows).toBeLessThan(fitted.rows);
  await expect.poll(() => remote).toEqual(await dimensions(page));
  expect(input).toEqual([]);
});

test('queued selector redraws stay in order across terminal geometry changes', async ({ page }) => {
  await queuedTerminal(page);
  const screen = page.locator('.xterm-rows');
  const rows = screen.locator(':scope > div');
  await page.evaluate(frame => window.terminalStream.deliver([
    `\u001b[?1049h\u001b[2J\u001b[HQuestion\r\n${frame}`,
  ]), selectorFrame(40, 0));
  await expect(rows.nth(1)).toContainText('> First option');

  // The old-grid redraw must finish before the following smaller-grid state applies.
  await page.evaluate(frame => window.terminalStream.deliver([
    `\u001b[3F\u001b[J${frame}`,
    { cols: 24, rows: 20 },
  ]), selectorFrame(40, 1));
  await expect(rows.nth(2)).toContainText('> Second option');
  await expect.poll(() => dimensions(page)).toEqual({ cols: 24, rows: 20 });

  for (const active of [2, 0, 1, 2]) {
    await page.evaluate(frame => window.terminalStream.deliver([
      `\u001b[3F\u001b[J${frame}`,
    ]), selectorFrame(24, active));
    // xterm retains clipped alternate-buffer cells after shrinking; this fixture uses one-column ASCII.
    await expect.poll(async () => (await rows.allTextContents()).map(row => row.slice(0, 24).trimEnd()).filter(Boolean)).toEqual([
      'Question', ...selectorFrame(24, active).split('\r\n'),
    ]);
    expect((await screen.innerText()).match(/> /g)).toHaveLength(1);
  }
});

test('queued output from an old attachment is cleared before restored selector output', async ({ page }) => {
  await queuedTerminal(page);
  await page.evaluate(() => {
    window.terminalStream.deliver(['\u001b[2J\u001b[HStale question\r\n> Stale choice\r\n']);
    window.terminalStream.reconnect();
  });
  const screen = page.locator('.xterm-rows');
  await expect(screen).toContainText('> Restored choice');
  await expect.poll(async () => (await screen.locator(':scope > div').allTextContents()).map(row => row.trimEnd()).filter(Boolean)).toEqual([
    'Restored question', '> Restored choice',
  ]);
});

test('keyboard viewport animation sends only the settled terminal dimensions', async ({ page }) => {
  let remote = { cols: 80, rows: 24 };
  const resizes: { cols: number; rows: number }[] = [];
  await page.routeWebSocket(/\/api\/v1\/terminal\//, ws => {
    const url = new URL(ws.url());
    remote = { cols: Number(url.searchParams.get('cols')), rows: Number(url.searchParams.get('rows')) };
    ws.onMessage(data => {
      if (typeof data !== 'string') return;
      const message = JSON.parse(data);
      if (message.type !== 'resize') return;
      remote = { cols: message.cols, rows: message.rows };
      resizes.push(remote);
      ws.send(JSON.stringify({ type: 'state', mode: 'control', ...remote }));
    });
    ws.send(JSON.stringify({ type: 'state', mode: 'control', ...remote }));
    ws.send(Buffer.from('READY'));
  });
  await page.goto(server.origin);
  await expect(page.locator('.xterm-rows')).toContainText('READY');
  const initial = await dimensions(page);
  await expect.poll(() => remote).toEqual(initial);
  resizes.length = 0;
  // main.ts maps the moving visual viewport to this CSS height during keyboard animation.
  await page.evaluate(async () => {
    for (const height of [760, 680, 600, 500]) {
      await new Promise<void>(resolve => requestAnimationFrame(() => {
        document.documentElement.style.setProperty('--app-height', `${height}px`);
        resolve();
      }));
    }
  });
  await expect.poll(async () => (await dimensions(page)).rows).toBeLessThan(initial.rows);
  await expect.poll(() => remote).toEqual(await dimensions(page));
  expect(resizes).toEqual([await dimensions(page)]);
});
