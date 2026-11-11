import { test, expect, type Locator, type Page } from '@playwright/test';
import sharp from 'sharp';
// @ts-expect-error This JavaScript fixture drives the real native server.
import { fixture } from './network-helper.mjs';

let machine: any;
test.beforeAll(async () => { machine = await fixture({ webRoot: process.env.EMACHINE_TEST_WEB_ROOT }); });
test.afterAll(async () => { await machine?.close(); });

const mascot = [
  ' \u2590\u259b\u2588\u2588\u2588\u259c\u258c ',
  '\u259d\u259c\u2588\u2588\u2588\u2588\u2588\u259b\u2598',
  '  \u2598\u2598 \u259d\u259d  ',
];
// The native mascot silhouette, on a half-cell grid. The two eyes are black.
const silhouette = [
  '   ############   ',
  '   ##B######B##   ',
  ' ################ ',
  '   ############   ',
  '    # #    # #    ',
  '                  ',
];
const orange = [215, 119, 87];
const content = '\u001b[2J\u001b[H\u001b[?25l\u001b[38;2;215;119;87m'
  + ' \u2590\u001b[48;2;0;0;0m\u259b\u2588\u2588\u2588\u259c\u001b[49m\u258c \r\n'
  + mascot.slice(1).join('\r\n') + '\r\n' + '\u2588'.repeat(60) + '\u001b[0mEND\r\n'
  + ' '.repeat(60) + '\u001b[31mREF\u001b[0m\r\nmascot ready';

async function checkMascot(page: Page, pane: Locator, background: number[], path: string) {
  const bounds = (await pane.locator('.xterm-rows > div').first().boundingBox())!;
  const cellWidth = bounds.width / 80, rowHeight = bounds.height;
  const clip = { x: Math.floor(bounds.x), y: Math.floor(bounds.y), width: Math.ceil(cellWidth * 9 + 1), height: Math.ceil(rowHeight * 3 + 1) };
  const png = await page.screenshot({ path, clip, scale: 'css', animations: 'disabled' });
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const expected = (x: number, y: number) => silhouette[Math.min(5, Math.max(0, Math.floor(y / rowHeight * 2)))]
    [Math.min(17, Math.max(0, Math.floor(x / cellWidth * 2)))];
  let checked = 0;
  const mismatches: string[] = [];
  for (let y = 1; y < info.height - 1; y++) for (let x = 1; x < info.width - 1; x++) {
    const px = x + .5 + clip.x - bounds.x, py = y + .5 + clip.y - bounds.y;
    if (px >= cellWidth * 9 || py >= rowHeight * 3) continue;
    const ink = expected(px, py);
    // Ignore antialiasing at silhouette edges, but check seams inside solid regions.
    if (expected(px - .8, py) !== ink || expected(px + .8, py) !== ink
      || expected(px, py - .8) !== ink || expected(px, py + .8) !== ink) continue;
    const wanted = ink === '#' ? orange : ink === 'B' ? [0, 0, 0] : background;
    const offset = (y * info.width + x) * info.channels;
    const actual = Array.from(data.subarray(offset, offset + 3));
    checked++;
    if (actual.some((channel, i) => Math.abs(channel - wanted[i]) > 8)) {
      if (mismatches.length < 12) mismatches.push(`${x},${y}: ${actual} instead of ${wanted}`);
    }
  }
  expect(checked).toBeGreaterThan(1000);
  expect(mismatches, 'block art must fill terminal cells without fallback-font gaps or overlaps').toEqual([]);
}

for (const platform of ['desktop', 'ios'] as const) test(`${platform} Claude mascot keeps native block geometry across themes and resize`, async ({ page }, testInfo) => {
  await page.setViewportSize(platform === 'desktop' ? { width: 1100, height: 800 } : { width: 390, height: 844 });
  await page.addInitScript(platform => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: platform === 'ios' ? 'MacIntel' : 'Linux x86_64' });
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: platform === 'ios' ? 5 : 0 });
  }, platform);
  const input: string[] = [];
  await page.routeWebSocket(/\/api\/v1\/terminal\//, ws => {
    ws.onMessage(data => { if (Buffer.isBuffer(data)) input.push(data.toString()); });
    ws.send(JSON.stringify({ type: 'state', mode: 'control', session: 'glyph-fixture', cols: 80, rows: 24 }));
    ws.send(Buffer.from(content));
  });
  await page.goto(machine.origin);
  const pane = page.locator('.terminal-pane:not([hidden])');
  await expect(pane.locator('.xterm-rows')).toContainText('mascot ready');
  for (const [index, theme] of ['light', 'dark', 'light'].entries()) {
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: /^Theme:/ }).click();
    if (index === 2) await page.setViewportSize(platform === 'desktop' ? { width: 900, height: 700 } : { width: 428, height: 926 });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const background = theme === 'light' ? [246, 245, 244] : platform === 'ios' ? [0, 0, 0] : [0, 36, 81];
    await checkMascot(page, pane, background, testInfo.outputPath(`mascot-${index}-${theme}.png`));
    const end = (await pane.locator('.xterm-rows').getByText('END', { exact: true }).boundingBox())!;
    const reference = (await pane.locator('.xterm-rows').getByText('REF', { exact: true }).boundingBox())!;
    const grid = (await pane.locator('.xterm-rows > div').first().boundingBox())!;
    expect(Math.abs(end.x - grid.x - grid.width / 80 * 60), 'long block runs stay on the terminal cell grid').toBeLessThan(.032);
    expect(Math.abs(end.x - reference.x), 'block and ordinary text columns align within one raster pixel').toBeLessThanOrEqual(1);
    for (let row = 0; row < mascot.length; row++) await expect(pane.locator('.xterm-rows > div').nth(row)).toHaveText(mascot[row]);
  }
  expect(input).toEqual([]);
});
