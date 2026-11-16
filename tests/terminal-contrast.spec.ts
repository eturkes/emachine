import { test, expect, type Locator, type Page } from '@playwright/test';
import sharp from 'sharp';
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

async function terminal(page: Page, content = output, lastLabel = 'dimBlack', platform: 'ios' | 'desktop' = 'ios') {
  const input: string[] = [];
  let sendOutput: (data: string) => void = () => { throw new Error('Terminal socket is not connected'); };
  await page.addInitScript(platform => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: platform === 'ios' ? 'MacIntel' : 'Linux x86_64' });
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: platform === 'ios' ? 5 : 0 });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => { (window as any).contrastCopiedText = text; },
    } });
  }, platform);
  await page.routeWebSocket(/\/api\/v1\/terminal\//, ws => {
    ws.onMessage(data => { if (Buffer.isBuffer(data)) input.push(data.toString()); });
    sendOutput = data => ws.send(Buffer.from(data));
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
  return { pane, input, sendOutput: (data: string) => sendOutput(data) };
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
      expect.soft(rendered.background, `${theme}: ${label}`).toEqual(theme === 'light' ? [246, 245, 244] : [0, 0, 0]);
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
  expect(light.yellowBackground.background).toEqual([246, 116, 0]);
  expect(light.rgbThinking.foreground).toEqual([150, 108, 30]);
  expect(light.rgbYellow.foreground).toEqual([136, 98, 26]);
  expect(light.brightYellow.foreground).toEqual([243, 228, 48]);
  expect(light.boldYellow.foreground).toEqual([246, 116, 0]);
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

test('iOS dark terminal uses black and makes dark ANSI and RGB text readable', async ({ page }) => {
  const content = '\u001b[2J\u001b[H' + [
    ['iosDefault', ''], ['iosBlack', '30'], ['iosDarkRgb', '38;2;33;33;33'], ['iosBlue', '34'],
  ].map(([label, sgr]) => `\u001b[0m\u001b[${sgr}m${label}\u001b[0m\r\n`).join('');
  const t = await terminal(page, content, 'iosBlue');
  for (const label of ['iosDefault', 'iosBlack', 'iosDarkRgb', 'iosBlue']) {
    const rendered = await colors(sample(t.pane, label));
    expect.soft(rendered.background, label).toEqual([0, 0, 0]);
    expect.soft(rendered.contrast, label).toBeGreaterThanOrEqual(4.5);
  }
  await page.getByRole('button', { name: /^Theme:/ }).click();
  await page.getByRole('button', { name: /^Theme:/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(async () => (await colors(sample(t.pane, 'iosDarkRgb'))).contrast).toBeGreaterThanOrEqual(4.5);
  expect((await colors(sample(t.pane, 'iosDefault'))).background).toEqual([0, 0, 0]);
});

test.describe('background-only terminal styles', () => {
  test.use({ viewport: { width: 1360, height: 900 }, isMobile: false, hasTouch: false });

  for (const platform of ['desktop', 'ios'] as const) test(`default text stays readable on program backgrounds (${platform})`, async ({ page }, testInfo) => {
    const samples = [
      ['codexPrompt', '48;2;68;68;68'], ['ansiBackground', '100'], ['indexedBackground', '48;5;8'],
      ['whiteBackground', '47'], ['lightBackground', '48;2;246;245;244'], ['blackBackground', '48;2;0;0;0'],
      ['inverseLight', '7;38;2;246;245;244'], ['inverseDark', '7;38;2;66;66;66'],
      ['dimPrompt', '2;48;2;68;68;68'], ['plainText', ''],
    ] as const;
    const content = '\u001b[2J\u001b[H' + samples.map(([label, sgr]) => `\u001b[0m\u001b[${sgr}m${label}\u001b[0m\r\n`).join('');
    const t = await terminal(page, content, 'plainText', platform);
    for (const theme of ['light', 'dark', 'light'] as const) {
      if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: /^Theme:/ }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await page.screenshot({ path: `test-results/background-only-${platform}-${theme}-${testInfo.project.name}.png`, animations: 'disabled' });
      for (const [label] of samples) {
        const rendered = await colors(sample(t.pane, label));
        expect.soft(rendered.contrast, `${platform} ${theme}: ${label} (${JSON.stringify(rendered)})`).toBeGreaterThanOrEqual(label === 'dimPrompt' ? 2.25 : 4.5);
      }
      expect((await colors(sample(t.pane, 'codexPrompt'))).background).toEqual([68, 68, 68]);
      expect((await colors(sample(t.pane, 'inverseLight'))).background).toEqual([246, 245, 244]);
      expect((await colors(sample(t.pane, 'inverseDark'))).background).toEqual([66, 66, 66]);
    }
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect.poll(async () => (await colors(sample(t.pane, 'codexPrompt'))).contrast).toBeGreaterThanOrEqual(4.5);
    const target = sample(t.pane, 'codexPrompt');
    const bounds = await target.boundingBox();
    expect(bounds).not.toBeNull();
    await page.mouse.dblclick(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
    await expect(target).toHaveClass(/xterm-decoration-top/);
    expect((await colors(target)).contrast).toBeGreaterThanOrEqual(4.5);
    await t.pane.getByRole('button', { name: 'Copy', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).contrastCopiedText)).toBe('codexPrompt');
    expect(t.input).toEqual([]);
  });
});

test.describe('desktop terminal palette', () => {
  test.use({ viewport: { width: 1360, height: 900 }, isMobile: false, hasTouch: false });

  test('desktop terminal preserves native palettes and raw RGB across themes and reload', async ({ page }) => {
    // Render independent color samples, including low-contrast RGB that desktop must preserve.
    const native = [
      ['defaultText', '', [252, 252, 252], [66, 66, 66]],
      ['ansiBlack', '30', [35, 38, 39], [33, 33, 33]],
      ['ansiRed', '31', [237, 21, 21], [237, 21, 21]],
      ['ansiGreen', '32', [17, 209, 22], [0, 166, 0]],
      ['ansiBlue', '34', [29, 153, 243], [0, 142, 196]],
      ['indexedYellow', '38;5;3', [246, 116, 0], [246, 116, 0]],
      ['indexedBlack', '38;5;16', [0, 0, 0], [0, 0, 0]],
      ['indexedGray', '38;5;232', [8, 8, 8], [8, 8, 8]],
      ['explicitRgb', '38;2;33;33;33', [33, 33, 33], [33, 33, 33]],
      ['explicitBright', '38;2;250;250;250', [250, 250, 250], [250, 250, 250]],
      ['normalYellow', '33', [246, 116, 0], [246, 116, 0]],
      ['brightYellow', '93', [253, 188, 75], [243, 228, 48]],
      ['boldYellow', '1;33', [246, 116, 0], [246, 116, 0]],
      ['dimYellow', '2;33', null, null],
      ['yellowBackground', '37;43', [252, 252, 252], [66, 66, 66]],
      ['rgbBackground', '38;2;1;2;3;48;2;9;10;11', [1, 2, 3], [1, 2, 3]],
    ] as const;
    const content = '\u001b[2J\u001b[H' + native.map(([label, sgr]) => `\u001b[0m\u001b[${sgr}m${label}\u001b[0m\r\n`).join('');
    const t = await terminal(page, content, 'rgbBackground', 'desktop');
    const check = async (theme: 'dark' | 'light') => {
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(t.pane.locator('.xterm-rows')).toContainText('rgbBackground');
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      for (const [label, , dark, light] of native) {
        const rendered = await colors(sample(t.pane, label));
        const foreground = theme === 'dark' ? dark : light;
        const background = label === 'yellowBackground' ? [246, 116, 0]
          : label === 'rgbBackground' ? [9, 10, 11]
          : theme === 'dark' ? [0, 36, 81] : [246, 245, 244];
        expect.soft(rendered.background, `${theme}: ${label} background`).toEqual(background);
        if (foreground) expect.soft(rendered.foreground, `${theme}: ${label} foreground`).toEqual(foreground);
        else for (let channel = 0; channel < 3; channel++) {
          expect.soft(rendered.foreground[channel], `${theme}: dim yellow channel ${channel}`)
            .toBeCloseTo(([246, 116, 0][channel] + background[channel]) / 2, 0);
        }
      }
      await expect(sample(t.pane, 'boldYellow')).toHaveCSS('font-weight', '700');
    };
    for (const theme of ['dark', 'light', 'dark'] as const) {
      if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: /^Theme:/ }).click();
      await check(theme);
      await page.reload();
      await check(theme);
    }
    const target = sample(t.pane, 'explicitRgb');
    const bounds = await target.boundingBox();
    expect(bounds).not.toBeNull();
    await page.mouse.dblclick(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
    await expect(target).toHaveClass(/xterm-decoration-top/);
    await t.pane.getByRole('button', { name: 'Copy', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).contrastCopiedText)).toBe('explicitRgb');
    expect(t.input).toEqual([]);
  });
});

test.describe('steady terminal cursor focus states', () => {
  test.use({ viewport: { width: 1360, height: 900 }, isMobile: false, hasTouch: false });

  for (const platform of ['desktop', 'ios'] as const) test(`cursor is filled when focused and outlined when blurred without blinking (${platform})`, async ({ page }, testInfo) => {
    if (platform === 'ios') await page.setViewportSize({ width: 390, height: 844 });
    // Match the screenshot's shaded prompt and blank cursor cell, not just the page background.
    const content = '\u001b[2J\u001b[H\u001b[48;2;235;234;233m> ffsa' + ' '.repeat(74)
      + '\u001b[1;7H\u001b[?25h\u001b[1 q';
    const t = await terminal(page, content, 'ffsa', platform);
    const cursor = t.pane.locator('.xterm-cursor');
    const input = t.pane.locator('.xterm-helper-textarea');
    const frame = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const outline = () => cursor.evaluate(element => {
      const style = getComputedStyle(element);
      return [style.outlineStyle, style.outlineWidth, style.outlineColor, style.outlineOffset];
    });
    const animationStates = () => cursor.evaluate(element => element.getAnimations().map(animation => ({
      state: animation.playState, time: animation.currentTime,
    })));

    for (const [pass, theme] of ['light', 'dark', 'light'].entries()) {
      if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: /^Theme:/ }).click();
      if (pass === 2) await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(t.pane.locator('.xterm-rows')).toContainText('ffsa');
      await input.focus();
      await expect(cursor).toHaveClass(/xterm-cursor-block/);
      await frame();
      let previousPixels: Buffer | undefined;
      for (const time of [100, 650]) {
        // Leave the cursor untouched across a blink interval to catch visible animation.
        await page.waitForTimeout(time);
        const animations = await animationStates();
        expect.soft(animations, 'application-requested blinking remains at its visible first frame')
          .toEqual(animations.map(() => ({ state: 'paused', time: 0 })));
        const png = await cursor.screenshot({ path: testInfo.outputPath(`cursor-${pass}-${theme}-${time}.png`), animations: 'allow' });
        const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        if (previousPixels) expect.soft(data.equals(previousPixels), 'cursor pixels do not blink').toBe(true);
        previousPixels = data;
        const center = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
        expect.soft(Array.from(data.subarray(center, center + 3)), `${theme} cursor fill stays visible`)
          .toEqual(theme === 'light' ? [69, 69, 69] : [214, 214, 214]);
        expect((await outline())[0], 'focused cursor is a filled block, without an outline').toBe('none');
        await expect(cursor).toHaveCSS('color', theme === 'light' ? 'rgb(246, 245, 244)'
          : platform === 'ios' ? 'rgb(0, 0, 0)' : 'rgb(0, 36, 81)');
      }
      await input.blur();
      await expect(cursor).toHaveClass(/xterm-cursor-outline/);
      await expect.poll(outline).toEqual(['solid', '1px', theme === 'light' ? 'rgb(69, 69, 69)' : 'rgb(214, 214, 214)', '-1px']);
      await expect.poll(animationStates).toEqual([]);
      const unfocused = await cursor.screenshot({ path: testInfo.outputPath(`cursor-${pass}-${theme}-unfocused.png`), animations: 'allow' });
      const { data, info } = await sharp(unfocused).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const center = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
      expect(Array.from(data.subarray(center, center + 3)), 'unfocused outline keeps the original prompt fill').toEqual([235, 234, 233]);
    }

    await input.focus();
    t.sendOutput('\u001b[2 q');
    await expect(cursor).not.toHaveClass(/xterm-cursor-blink/);
    await expect.poll(async () => (await outline())[0]).toBe('none');
    await expect(cursor).toHaveCSS('background-color', 'rgb(69, 69, 69)');
    for (const [sequence, shape] of [['5', 'bar'], ['3', 'underline']]) {
      t.sendOutput(`\u001b[${sequence} q`);
      await expect(cursor).toHaveClass(new RegExp(`xterm-cursor-${shape}`));
      await expect.poll(async () => (await outline())[0]).toBe('none');
      await frame();
      await expect.poll(animationStates).toEqual([{ state: 'paused', time: 0 }]);
      if (shape === 'bar') await expect(cursor).not.toHaveCSS('box-shadow', 'none');
      else await expect(cursor).toHaveCSS('border-bottom-style', 'solid');
    }
    t.sendOutput('\u001b[1 q\u001b[?25l');
    await expect(cursor).toHaveCount(0);
    t.sendOutput('\u001b[1;9H\u001b[?25h');
    await expect(cursor).toHaveCount(1);
    await expect(cursor).toHaveClass(/xterm-cursor-block/);
    await expect.poll(async () => (await outline())[0]).toBe('none');
    await expect(cursor).toHaveCSS('background-color', 'rgb(69, 69, 69)');
    t.sendOutput('\u001b[0 q');
    await expect(cursor).not.toHaveClass(/xterm-cursor-blink/);
    await expect.poll(animationStates).toEqual([]);
    t.sendOutput('\u001b[1;9HQ\u001b[1;9H\u001b[?12h');
    await expect(cursor).toHaveText('Q');
    await expect(cursor).toHaveCSS('color', 'rgb(246, 245, 244)');
    await frame();
    await expect.poll(animationStates).toEqual([{ state: 'paused', time: 0 }]);
    await input.blur();
    await expect(cursor).toHaveClass(/xterm-cursor-outline/);
    await expect(cursor).toHaveText('Q');
    await expect(cursor).toHaveCSS('background-color', 'rgb(235, 234, 233)');
    await expect(cursor).toHaveCSS('color', 'rgb(66, 66, 66)');
    await input.focus();
    await expect(cursor).toHaveClass(/xterm-cursor-block/);
    await expect(cursor).toHaveCSS('background-color', 'rgb(69, 69, 69)');
    await expect(cursor).toHaveCSS('color', 'rgb(246, 245, 244)');
    expect(t.input).toEqual([]);
  });
});
