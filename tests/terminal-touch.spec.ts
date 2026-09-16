import { test, expect, type Locator, type Page } from '@playwright/test';
// @ts-expect-error This JavaScript fixture drives the real native server.
import { fixture } from './network-helper.mjs';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
let server: any;
test.beforeAll(async () => { server = await fixture(); });
test.afterAll(async () => { await server?.close(); });

async function terminal(page: Page, mode = 'control', cols = 40, rows = 24) {
  const input: string[] = [];
  let send!: (data: string | Buffer) => void;
  await page.routeWebSocket(/\/api\/v1\/terminal\//, ws => {
    send = data => ws.send(data);
    ws.onMessage(data => { if (Buffer.isBuffer(data)) input.push(data.toString()); });
    send(JSON.stringify({ type: 'state', mode, session: 'touch-fixture', cols, rows }));
    send(Buffer.from(Array.from({ length: 400 }, (_, i) => `ROW${String(i).padStart(4, '0')}\r\n`).join('')));
  });
  await page.goto(server.origin);
  await expect(page.locator('.terminal-pane')).toHaveAttribute('data-mode', mode);
  await expect(page.locator('.xterm-rows')).toContainText('ROW0399');
  return { input, send, host: page.locator('.terminal-host'), screen: page.locator('.xterm-screen') };
}

async function swipe(page: Page, target: Locator, dx: number, dy: number, steps = 12) {
  const box = (await target.boundingBox())!;
  const x = box.x + Math.min(box.width / 2, 180), y = box.y + Math.min(box.height / 2, 220);
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
    for (let i = 1; i <= steps; i++) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * i / steps, y: y + dy * i / steps, id: 1 }] });
      await page.evaluate(() => new Promise(requestAnimationFrame));
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally { await session.detach(); }
}

const firstRow = (page: Page) => page.locator('.xterm-rows').evaluate(element => Number(/ROW(\d+)/.exec(element.textContent ?? '')?.[1]));
const viewport = (page: Page) => page.evaluate(() => ({
  x: scrollX, y: scrollY, top: visualViewport?.offsetTop, left: visualViewport?.offsetLeft,
  appTop: document.querySelector('.app')!.getBoundingClientRect().top,
  hostTop: document.querySelector('.terminal-host')!.scrollTop,
}));

test('terminal touch scrolls history, contains both edges and preserves taps and the key strip', async ({ page }) => {
  const { input, host } = await terminal(page);
  const bottom = await firstRow(page), fixed = await viewport(page);
  await swipe(page, host, 0, 144);
  await expect.poll(() => firstRow(page)).toBeLessThan(bottom - 3);
  expect(await viewport(page)).toEqual(fixed);
  await expect(page.locator('.xterm-helper-textarea')).not.toBeFocused();
  await swipe(page, host, 0, -144);
  await expect.poll(() => firstRow(page)).toBe(bottom);
  await swipe(page, host, 0, -144);
  expect(await firstRow(page)).toBe(bottom);
  expect(await viewport(page)).toEqual(fixed);
  // Use the scrollbar to reach the boundary; CDP wheel deltas can normalize to a single tick.
  const box = (await host.boundingBox())!;
  await page.mouse.move(box.x + 80, box.y + 80);
  const thumb = (await page.locator('.xterm-scrollable-element > .scrollbar.vertical > .slider').boundingBox())!;
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
  await page.mouse.down();
  await page.mouse.move(thumb.x + thumb.width / 2, box.y, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => firstRow(page)).toBe(0);
  await swipe(page, host, 0, 144);
  expect(await firstRow(page)).toBe(0);
  expect(await viewport(page)).toEqual(fixed);
  expect(input).toEqual([]);
  const keys = page.locator('.terminal-keys');
  await swipe(page, keys, -130, 0);
  await expect.poll(() => keys.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  await page.touchscreen.tap(box.x + 80, box.y + 80);
  await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
});

test('terminal touch supports small moves and cancels gestures without stealing horizontal observer scrolling', async ({ page }) => {
  const { input, host } = await terminal(page, 'observe', 120, 50);
  const bottom = await firstRow(page), fixed = await viewport(page);
  await swipe(page, host, 0, 64, 32);
  await expect.poll(() => firstRow(page)).toBeLessThan(bottom);
  expect(await viewport(page)).toEqual(fixed);
  const older = await firstRow(page);
  // Synthetic lifecycle events cover interrupted and multi-finger gestures deterministically.
  const cancelled = await host.evaluate(element => {
    const box = element.getBoundingClientRect();
    const touch = (identifier: number, y: number) => new Touch({ identifier, target: element, clientX: box.x + 80, clientY: box.y + y });
    const fire = (type: string, touches: Touch[]) => {
      const event = new TouchEvent(type, { bubbles: true, cancelable: true, touches, targetTouches: touches, changedTouches: touches });
      element.dispatchEvent(event); return event.defaultPrevented;
    };
    const cancelled: boolean[] = [];
    fire('touchstart', [touch(1, 100)]);
    fire('touchcancel', []);
    cancelled.push(fire('touchmove', [touch(1, 200)]));
    fire('touchstart', [touch(1, 100)]);
    fire('touchstart', [touch(1, 100), touch(2, 150)]);
    cancelled.push(fire('touchmove', [touch(1, 200), touch(2, 250)]));
    fire('touchend', [touch(1, 200)]);
    cancelled.push(fire('touchmove', [touch(1, 300)]));
    fire('touchend', []);
    return cancelled;
  });
  expect(cancelled).toEqual([false, false, false]);
  expect(await firstRow(page)).toBe(older);
  await swipe(page, host, -130, 0);
  await expect.poll(() => host.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  expect(await firstRow(page)).toBe(older);
  expect(await viewport(page)).toEqual(fixed);
  expect(input).toEqual([]);
});

test('terminal touch keeps alternate-screen cursor and mouse wheel protocols', async ({ page }) => {
  const { input, send, host } = await terminal(page);
  const fixed = await viewport(page);
  send(Buffer.from('\u001b[?1049h\u001b[?1h\u001b[HALTERNATE'));
  await expect(page.locator('.xterm-rows')).toContainText('ALTERNATE');
  await swipe(page, host, 0, 96);
  await expect.poll(() => input.join('')).toMatch(/^(\u001bOA)+$/);
  input.length = 0;
  await swipe(page, host, 0, -96);
  await expect.poll(() => input.join('')).toMatch(/^(\u001bOB)+$/);
  input.length = 0;
  send(Buffer.from('\u001b[?1000h\u001b[?1006h\u001b[HMOUSE'));
  await expect(page.locator('.xterm-rows')).toContainText('MOUSE');
  await swipe(page, host, 0, 96);
  await expect.poll(() => input.join('')).toMatch(/^(\u001b\[<64;\d+;\d+M)+$/);
  input.length = 0;
  await swipe(page, host, 0, -96);
  await expect.poll(() => input.join('')).toMatch(/^(\u001b\[<65;\d+;\d+M)+$/);
  expect(await viewport(page)).toEqual(fixed);
});
