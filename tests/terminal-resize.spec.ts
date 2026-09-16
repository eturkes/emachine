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
