import { test, expect, type Locator, type Page } from '@playwright/test';
// @ts-expect-error This JavaScript fixture drives the real native server.
import { fixture } from './network-helper.mjs';

let machine: any;
test.beforeAll(async () => { machine = await fixture(); });
test.afterAll(async () => { await machine?.close(); });
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark' });

const samples = [
  ['ansiBlack', '30'], ['paletteBlack', '38;5;0'], ['indexedBlack', '38;5;16'],
  ['indexedGray', '38;5;232'], ['rgbBlack', '38;2;0;0;0'],
  ['blackOnWhite', '38;2;0;0;0;48;2;255;255;255'],
  ['ansiOnWhite', '30;48;2;255;255;255'],
  ['blackOnDark', '38;2;0;0;0;48;2;16;16;16'],
  ['inverseDefault', '7'], ['inverseExplicit', '38;2;255;255;255;48;2;0;0;0;7'],
  ['readableGreen', '38;2;0;255;0;48;2;0;0;0'], ['dimBlack', '2;38;2;0;0;0'],
] as const;
const output = '\u001b[2J\u001b[H' + samples.map(([label, sgr]) => `\u001b[0m\u001b[${sgr}m${label}\u001b[0m\r\n`).join('');

async function terminal(page: Page, content = output, lastLabel = 'dimBlack') {
  const input: string[] = [];
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'iPhone' });
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => { (window as any).contrastCopiedText = text; },
    } });
  });
  await page.routeWebSocket(/\/api\/v1\/terminal\//, ws => {
    ws.onMessage(data => { if (Buffer.isBuffer(data)) input.push(data.toString()); });
    ws.send(JSON.stringify({ type: 'state', mode: 'control', session: 'contrast-fixture', cols: 80, rows: 24 }));
    ws.send(Buffer.from(content));
  });
  await page.goto(machine.origin);
  const pane = page.locator('.terminal-pane:not([hidden])');
  await expect(pane).toHaveAttribute('data-mode', 'control');
  await expect(pane.locator('.xterm-rows')).toContainText(lastLabel);
  // ChromiumFish may keep the host appearance despite colorScheme emulation.
  if (await page.locator('html').getAttribute('data-theme') !== 'dark') await page.getByRole('button', { name: /^Theme:/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return { pane, input };
}

function sample(pane: Locator, label: string) {
  return pane.locator('.xterm-rows span').filter({ hasText: new RegExp(`^${label}$`) }).first();
}

async function colors(element: Locator) {
  return element.evaluate(element => {
    const rgba = (css: string) => {
      const values = css.match(/[\d.]+/g)!.map(Number);
      return [values[0], values[1], values[2], values[3] ?? 1];
    };
    const over = (fg: number[], bg: number[]) => fg.slice(0, 3).map((value, i) => value * fg[3] + bg[i] * (1 - fg[3]));
    const layers: Element[] = [];
    for (let node: Element | null = element; node; node = node.parentElement) layers.unshift(node);
    let background = [255, 255, 255];
    for (const node of layers) background = over(rgba(getComputedStyle(node).backgroundColor), background);
    // xterm paints selection in a sibling layer underneath selected text.
    if (element.classList.contains('xterm-decoration-top')) {
      const selection = element.closest('.xterm')!.querySelector('.xterm-selection > div');
      if (selection) background = over(rgba(getComputedStyle(selection).backgroundColor), background);
    }
    const foreground = over(rgba(getComputedStyle(element).color), background);
    const luminance = (rgb: number[]) => rgb.map(value => {
      const channel = value / 255;
      return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
    }).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
    const levels = [luminance(foreground), luminance(background)].sort((a, b) => a - b);
    return { foreground, background, contrast: (levels[1] + .05) / (levels[0] + .05) };
  });
}

test('terminal corrects explicit dark text against each cell background in dark mode across theme changes', async ({ page }) => {
  const t = await terminal(page);
  for (const theme of ['dark', 'light', 'dark']) {
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: /^Theme:/ }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    // Changing a theme schedules xterm's row redraw on the next frame.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    for (const [label] of samples.filter(([label]) => label !== 'dimBlack' && (theme === 'dark' || label !== 'blackOnDark'))) {
      const rendered = await colors(sample(t.pane, label));
      expect.soft(rendered.contrast, `${theme}: ${label} (${JSON.stringify(rendered)})`).toBeGreaterThanOrEqual(4.5);
    }
    expect((await colors(sample(t.pane, 'blackOnWhite'))).foreground).toEqual([0, 0, 0]);
    expect((await colors(sample(t.pane, 'readableGreen'))).foreground).toEqual([0, 255, 0]);
  }
  expect(t.input).toEqual([]);
});

test('light terminal preserves native reference text colors across theme changes and reload', async ({ page }, testInfo) => {
  const native = [
    ['nativeDefault', '', [66, 66, 66]],
    ['nativeBlack', '38;2;0;0;0', [0, 0, 0]],
    ['nativeMuted', '38;2;102;102;102', [102, 102, 102]],
    ['nativeFaint', '38;2;157;157;157', [157, 157, 157]],
    ['nativeBlue', '38;2;87;105;247', [87, 105, 247]],
    ['nativeSuccess', '38;2;44;122;57', [44, 122, 57]],
    ['nativeSpinner', '38;2;215;119;87', [215, 119, 87]],
    ['nativeWarning', '38;2;171;43;63', [171, 43, 63]],
    ['nativeEffort', '38;2;246;116;0', [246, 116, 0]],
    ['nativeTime', '38;2;0;166;0', [0, 166, 0]],
    ['nativeAnsiYellow', '33', [246, 116, 0]],
    ['nativeIndexedYellow', '38;5;3', [246, 116, 0]],
    ['nativeAdv', '38;2;71;130;200', [71, 130, 200]],
  ] as const;
  const reference = '\u001b[2J\u001b[H' + native.map(([label, sgr]) => `\u001b[0m\u001b[${sgr}m${label}\u001b[0m\r\n`).join('');
  const t = await terminal(page, reference, 'nativeAdv');
  for (const theme of ['light', 'dark', 'light']) {
    await page.getByRole('button', { name: /^Theme:/ }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    for (const [label, , rgb] of native) {
      const rendered = await colors(sample(t.pane, label));
      if (theme === 'light') expect.soft(rendered.foreground, label).toEqual(rgb);
      else expect.soft(rendered.contrast, label).toBeGreaterThanOrEqual(4.5);
      expect.soft(rendered.background, `${theme}: ${label}`).toEqual(theme === 'light' ? [247, 247, 247] : [0, 0, 0]);
    }
    if (theme === 'dark') expect((await colors(sample(t.pane, 'nativeDefault'))).foreground).toEqual([231, 231, 231]);
    await page.screenshot({ path: `test-results/native-text-${theme}-${testInfo.project.name}.png`, animations: 'disabled' });
  }
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(t.pane.locator('.xterm-rows')).toContainText('nativeAdv');
  for (const [label, , rgb] of native) expect.soft((await colors(sample(t.pane, label))).foreground, `reloaded: ${label}`).toEqual(rgb);
  expect(t.input).toEqual([]);
});

test('native yellow text preserves dim styling, cell backgrounds and explicit RGB colors', async ({ page }) => {
  const samples = [
    ['yellow', '33'], ['dimYellow', '2;33'], ['yellowBackground', '37;43'],
    ['rgbThinking', '38;2;150;108;30'], ['brightYellow', '93'],
    ['boldYellow', '1;33'], ['rgbYellow', '38;2;136;98;26'],
  ] as const;
  const output = '\u001b[2J\u001b[H' + samples.map(([label, sgr]) => `\u001b[0m\u001b[${sgr}m${label}\u001b[0m\r\n`).join('');
  const t = await terminal(page, output, 'rgbYellow');
  const read = async () => Object.fromEntries(await Promise.all(samples.map(async ([label]) => [label, await colors(sample(t.pane, label))])));
  const dark = await read();
  await page.getByRole('button', { name: /^Theme:/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const light = await read();
  expect(light.yellow.foreground).toEqual([246, 116, 0]);
  for (let channel = 0; channel < 3; channel++) {
    expect(light.dimYellow.foreground[channel]).toBeCloseTo((light.yellow.foreground[channel] + light.dimYellow.background[channel]) / 2, 0);
  }
  expect(light.yellowBackground.background).toEqual([136, 98, 26]);
  expect(light.rgbThinking.foreground).toEqual([150, 108, 30]);
  expect(light.rgbYellow.foreground).toEqual([136, 98, 26]);
  expect(light.brightYellow.foreground).toEqual([144, 109, 36]);
  expect(light.boldYellow.foreground).toEqual([144, 109, 36]);
  await page.getByRole('button', { name: /^Theme:/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await read()).toEqual(dark);
  expect(t.input).toEqual([]);
});

test('terminal keeps dim and selected text readable without changing copied bytes', async ({ page }) => {
  const t = await terminal(page);
  const normal = await colors(sample(t.pane, 'rgbBlack'));
  const dim = await colors(sample(t.pane, 'dimBlack'));
  expect.soft(dim.contrast).toBeGreaterThanOrEqual(2.25);
  expect.soft(dim.contrast).toBeLessThan(normal.contrast);
  const target = sample(t.pane, 'rgbBlack');
  const bounds = await target.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.dblclick(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
  await expect(target).toHaveClass(/xterm-decoration-top/);
  expect((await colors(target)).contrast).toBeGreaterThanOrEqual(4.5);
  await t.pane.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).contrastCopiedText)).toBe('rgbBlack');
  expect(t.input).toEqual([]);
});

test('phone dark theme keeps the terminal and surrounding surfaces pure black across reload', async ({ page }, testInfo) => {
  const t = await terminal(page);
  for (let pass = 0; pass < 2; pass++) {
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(t.pane.locator('.xterm-rows')).toContainText('dimBlack');
    for (const selector of ['html', '.tab-header', '.terminal-main', '.terminal-toolbar', '.terminal-host .xterm-viewport']) {
      expect.soft((await colors(page.locator(selector).first())).background, selector).toEqual([0, 0, 0]);
    }
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', /^(#000|#000000)$/);
    if (!pass) await page.reload();
  }
  await page.screenshot({ path: `test-results/emachine-oled-${testInfo.project.name}.png`, animations: 'disabled' });
  expect(t.input).toEqual([]);
});
