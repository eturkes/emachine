import { test, expect, type Locator, type Page } from '@playwright/test';
// @ts-expect-error This JavaScript fixture drives the real native server.
import { fixture } from './network-helper.mjs';

let machine: any;
test.beforeAll(async () => { machine = await fixture(); });
test.afterAll(async () => { await machine?.close(); });
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

async function terminal(page: Page, platform = 'iPhone') {
  const input: string[] = [];
  let send!: (data: string | Buffer) => void;
  let disconnect!: () => void;
  await page.addInitScript(platform => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: platform });
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 });
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: platform === 'iPhone'
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'
      : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15' });
    const clipboard = { writes: [] as string[], denied: false };
    (window as any).copyFixture = clipboard;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => {
        if (clipboard.denied) throw new DOMException('Denied', 'NotAllowedError');
        clipboard.writes.push(text);
      },
    } });
  }, platform);
  await page.routeWebSocket(/\/api\/v1\/terminal\//, ws => {
    send = data => ws.send(data); disconnect = () => ws.close();
    ws.onMessage(data => { if (Buffer.isBuffer(data)) input.push(data.toString()); });
    send(JSON.stringify({ type: 'state', mode: 'control', session: 'copy-output', cols: 80, rows: 24 }));
    send(Buffer.from('\u001b[2J\u001b[Houtput ready'));
  });
  await page.goto(machine.origin);
  const pane = page.locator('.terminal-pane:not([hidden])');
  await expect(pane).toHaveAttribute('data-mode', 'control');
  await expect(pane.locator('.xterm-rows')).toContainText('output ready');
  const open = async () => {
    await pane.getByRole('button', { name: 'Copy', exact: true }).tap();
    const dialog = pane.getByRole('dialog', { name: 'Copy terminal output', exact: true, includeHidden: true });
    await expect(dialog).toBeVisible({ timeout: 3000 });
    return { dialog, output: dialog.getByRole('textbox', { name: 'Terminal output', exact: true, includeHidden: true }) };
  };
  return { pane, input, send, disconnect, open };
}
const writes = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).copyFixture.writes);
async function select(text: Locator, start: number, end: number) {
  await text.evaluate((element: HTMLTextAreaElement, { start, end }) => {
    element.focus(); element.setSelectionRange(start, end); element.dispatchEvent(new Event('select', { bubbles: true }));
  }, { start, end });
}

type Point = { x: number; y: number };
async function cell(pane: Locator, line: string, column: number): Promise<Point> {
  const span = pane.locator('.xterm-rows').getByText(line, { exact: true }).first();
  const bounds = (await span.boundingBox())!;
  // These fixture rows contain single-width ASCII cells.
  return { x: bounds.x + (column + 0.5) * bounds.width / line.length, y: bounds.y + bounds.height / 2 };
}

async function finger(page: Page, phase: 'start' | 'move' | 'end' | 'cancel', origin: Point, at = origin) {
  await page.evaluate(({ phase, origin, at }) => {
    const target = document.elementFromPoint(origin.x, origin.y)!;
    const touch = { identifier: 1, target, clientX: at.x, clientY: at.y };
    const finished = phase === 'end' || phase === 'cancel';
    target.dispatchEvent(new PointerEvent({ start: 'pointerdown', move: 'pointermove', end: 'pointerup', cancel: 'pointercancel' }[phase], {
      bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 1, isPrimary: true,
      button: 0, buttons: finished ? 0 : 1, clientX: at.x, clientY: at.y,
    }));
    const event = new Event('touch' + phase, { bubbles: true, cancelable: true });
    Object.defineProperties(event, { touches: { value: finished ? [] : [touch] }, changedTouches: { value: [touch] } });
    target.dispatchEvent(event);
  }, { phase, origin, at });
}

async function hold(page: Page, browserName: string, pane: Locator, start: Point, dragTo?: Point | (() => Promise<Point>)) {
  const session = browserName === 'chromium' ? await page.context().newCDPSession(page) : undefined;
  const dispatch = (phase: 'start' | 'move' | 'end', at: Point) => {
    if (!session) return finger(page, phase, start, at);
    return session.send('Input.dispatchTouchEvent', {
      type: ({ start: 'touchStart', move: 'touchMove', end: 'touchEnd' } as const)[phase],
      touchPoints: phase === 'end' ? [] : [{ ...at, id: 1 }],
    });
  };
  const selected = pane.locator('.xterm-selection > div').first();
  try {
    await dispatch('start', start);
    await expect(selected).toBeVisible({ timeout: 3000 });
    const end = typeof dragTo === 'function' ? await dragTo() : dragTo;
    if (end) {
      for (let step = 1; step <= 4; step++) await dispatch('move', {
        x: start.x + (end.x - start.x) * step / 4, y: start.y + (end.y - start.y) * step / 4,
      });
    }
    await dispatch('end', end ?? start);
    await expect(selected).toBeVisible();
  } finally { await session?.detach(); }
}

test('a deliberate hold selects the touched word without focusing the terminal', async ({ page, browserName }) => {
  const t = await terminal(page);
  await hold(page, browserName, t.pane, await cell(t.pane, 'output ready', 8));
  const helper = t.pane.locator('.xterm-helper-textarea');
  await expect(helper).not.toBeFocused();
  await t.pane.getByRole('button', { name: 'Copy', exact: true }).tap();
  await expect.poll(() => writes(page)).toEqual(['ready']);
  await expect(helper).not.toBeFocused();
  expect(t.input).toEqual([]);
});

for (const backward of [false, true]) test(`a deliberate hold extends ${backward ? 'backward' : 'across rows'} before release`, async ({ page, browserName }) => {
  const t = await terminal(page);
  const first = 'alpha beta gamma', second = 'delta epsilon';
  t.send(Buffer.from('\u001b[2J\u001b[H' + first + '\r\n' + second));
  await expect(t.pane.locator('.xterm-rows')).toContainText(second);
  const start = await cell(t.pane, first, 7);
  const end = await cell(t.pane, backward ? first : second, 2);
  await hold(page, browserName, t.pane, start, end);
  await expect(t.pane.locator('.xterm-helper-textarea')).not.toBeFocused();
  if (backward) await page.evaluate(() => { (window as any).copyFixture.denied = true; });
  await t.pane.getByRole('button', { name: 'Copy', exact: true }).tap();
  if (backward) {
    const output = t.pane.getByRole('textbox', { name: 'Terminal output', exact: true });
    await expect(output).toBeVisible();
    await expect(output).toHaveAttribute('readonly', '');
    expect(await output.evaluate((field: HTMLTextAreaElement) => field.value.slice(field.selectionStart, field.selectionEnd))).toBe('pha beta');
    expect(await writes(page)).toEqual([]);
  } else {
    await expect.poll(() => writes(page)).toEqual(['beta gamma\ndel']);
    await expect(t.pane.locator('.xterm-helper-textarea')).not.toBeFocused();
  }
  expect(t.input).toEqual([]);
});

test('a deliberate hold on a wide trailing cell selects the complete soft-wrapped word in scrollback', async ({ page, browserName }) => {
  const t = await terminal(page);
  t.send(JSON.stringify({ type: 'state', mode: 'observe', cols: 20, rows: 10 }));
  await expect(t.pane).toHaveAttribute('data-mode', 'observe');
  const history = Array.from({ length: 40 }, (_, i) => 'history-' + i + '\r\n').join('');
  const word = 'abcd\u754ce\u0301f';
  t.send(Buffer.from('\u001b[2J\u001b[3J\u001b[H' + history + ' '.repeat(15) + word));
  const rows = t.pane.locator('.xterm-rows');
  const wrapped = rows.locator(':scope > div').filter({ hasText: '\u754c' });
  await expect(wrapped).toContainText('\u754ce\u0301f');
  await expect(wrapped).not.toContainText('abcd');
  await expect(rows).not.toContainText('history-0');
  const row = (await wrapped.boundingBox())!, screen = (await t.pane.locator('.xterm-screen').boundingBox())!;
  await hold(page, browserName, t.pane, { x: screen.x + 1.5 * screen.width / 20, y: row.y + row.height / 2 });
  await t.pane.getByRole('button', { name: 'Copy', exact: true }).tap();
  await expect.poll(() => writes(page)).toEqual([word]);
  expect(t.input).toEqual([]);
});

test('a deliberate hold tracks its original word when new output trims full scrollback', async ({ page, browserName }) => {
  const t = await terminal(page);
  t.send(JSON.stringify({ type: 'state', mode: 'observe', cols: 20, rows: 10 }));
  await expect(t.pane).toHaveAttribute('data-mode', 'observe');
  const history = Array.from({ length: 10020 }, (_, i) => i + '\r\n').join('');
  t.send(Buffer.from(history + 'hold original\r\nfinish there'));
  const rows = t.pane.locator('.xterm-rows');
  await expect(rows).toContainText('finish there');
  await hold(page, browserName, t.pane, await cell(t.pane, 'hold original', 6), async () => {
    t.send(Buffer.from('\r\nnew row'));
    await expect(rows).toContainText('new row');
    return cell(t.pane, 'finish there', 2);
  });
  await t.pane.getByRole('button', { name: 'Copy', exact: true }).tap();
  await expect.poll(() => writes(page)).toEqual(['original\nfin']);
  expect(t.input).toEqual([]);
});

test('interrupted touch and application mouse tracking suppress deliberate hold selection', async ({ page }) => {
  const t = await terminal(page);
  const selected = t.pane.locator('.xterm-selection > div');
  const start = await cell(t.pane, 'output ready', 8);
  await page.clock.install();
  await finger(page, 'start', start);
  await finger(page, 'cancel', start);
  await page.clock.runFor(1000);
  await expect(selected).toHaveCount(0);
  t.send(Buffer.from('\u001b[?1000h\u001b[?1006h\r\nmouse ready'));
  await expect(t.pane.locator('.xterm-rows')).toContainText('mouse ready');
  const mouse = await cell(t.pane, 'mouse ready', 8);
  await finger(page, 'start', mouse);
  await page.clock.runFor(1000);
  await expect(selected).toHaveCount(0);
  await finger(page, 'end', mouse);
});

test('repeated finger taps leave terminal output unselected and Copy opens the snapshot', async ({ page }) => {
  const t = await terminal(page);
  const word = t.pane.locator('.xterm-rows span').filter({ hasText: /^output ready$/ }).first();
  const bounds = (await word.boundingBox())!;
  const x = bounds.x + 5, y = bounds.y + bounds.height / 2;
  await page.touchscreen.tap(x, y);
  await page.touchscreen.tap(x, y);
  await expect(t.pane.locator('.xterm-helper-textarea')).toBeFocused();
  const { output } = await t.open();
  await expect(output).toHaveValue('output ready');
  expect(await writes(page)).toEqual([]);
  expect(t.input).toEqual([]);
});

test('a single finger tap clears a mouse selection on the same terminal', async ({ page }) => {
  const t = await terminal(page);
  const word = t.pane.locator('.xterm-rows span').filter({ hasText: /^output ready$/ }).first();
  const bounds = (await word.boundingBox())!;
  await page.mouse.dblclick(bounds.x + 5, bounds.y + bounds.height / 2);
  const selection = t.pane.locator('.xterm-selection > div');
  await expect(selection.first()).toBeVisible();
  await page.touchscreen.tap(bounds.x + bounds.width - 5, bounds.y + bounds.height / 2);
  await expect(selection).toHaveCount(0, { timeout: 3000 });
});

test('iOS Copy exposes stable native selection and preserves wrapped Unicode and spaces', async ({ page }) => {
  const t = await terminal(page);
  t.send(JSON.stringify({ type: 'state', mode: 'observe', cols: 20, rows: 24 }));
  await expect(t.pane).toHaveAttribute('data-mode', 'observe');
  const first = 'x'.repeat(19) + '\u754ce\u0301 \ud83d\ude42 ' + 'wrapped output '.repeat(4);
  const expected = first + '\n\n  <b>literal</b>  \nlast';
  t.send(Buffer.from('\u001b[2J\u001b[3J\u001b[H' + expected.replaceAll('\n', '\r\n')));
  await expect(t.pane.locator('.xterm-rows')).toContainText('last');
  const { dialog, output } = await t.open();
  await expect(output).toHaveValue(expected);
  await expect(output).toHaveAttribute('readonly', '');
  await expect(output).toBeEnabled();
  await expect(output).toHaveCSS('font-size', '16px');
  await expect(t.pane.locator('.xterm-helper-textarea')).not.toBeFocused();
  expect(await writes(page)).toEqual([]);
  const selection = dialog.getByRole('button', { name: 'Copy selection', exact: true });
  await expect(selection).toBeDisabled();
  t.send(Buffer.from('\r\nnew output'));
  await expect(t.pane.locator('.xterm-rows')).toContainText('new output');
  await expect(output).toHaveValue(expected);
  const selected = '\u754ce\u0301 \ud83d\ude42';
  const start = expected.indexOf(selected);
  await select(output, start, start + selected.length);
  await selection.tap();
  await expect.poll(() => writes(page)).toEqual([selected]);
  await expect(dialog.getByRole('status')).toContainText('Copied selection.');
  await dialog.getByRole('button', { name: 'Copy all', exact: true }).tap();
  await expect.poll(() => writes(page)).toEqual([selected, expected]);
  expect(await output.evaluate((element: HTMLTextAreaElement) => element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })))).toBe(true);
  expect(t.input).toEqual([]);
  await dialog.getByRole('button', { name: 'Close output', exact: true }).tap();
  await expect(dialog).toBeHidden();
  await expect(t.pane.locator('.xterm-helper-textarea')).not.toBeFocused();
  await expect(t.pane.getByRole('button', { name: 'Copy', exact: true })).toBeFocused();
  const reopened = await t.open();
  await expect(reopened.output).toHaveValue(expected + '\nnew output');
});

test('iPad Copy includes scrollback and snapshots only the active alternate screen', async ({ page }) => {
  const t = await terminal(page, 'MacIntel');
  const history = Array.from({ length: 70 }, (_, index) => 'history ' + index).join('\r\n');
  t.send(Buffer.from('\u001b[2J\u001b[3J\u001b[H' + history));
  await expect(t.pane.locator('.xterm-rows')).toContainText('history 69');
  const normal = await t.open();
  await expect(normal.output).toHaveValue(history.replaceAll('\r\n', '\n'));
  await normal.dialog.getByRole('button', { name: 'Close output', exact: true }).tap();
  t.send(Buffer.from('\u001b[?1049h\u001b[2J\u001b[Halternate\u001b[3;1Hbelow cursor\u001b[H'));
  await expect(t.pane.locator('.xterm-rows')).toContainText('below cursor');
  const alternate = await t.open();
  await expect(alternate.output).toHaveValue('alternate\n\nbelow cursor');
  await alternate.dialog.getByRole('button', { name: 'Copy all', exact: true }).tap();
  await expect.poll(() => writes(page)).toEqual(['alternate\n\nbelow cursor']);
  expect(t.input).toEqual([]);
});

test('iOS Copy keeps native selection available after clipboard denial and while disconnected', async ({ page }) => {
  const t = await terminal(page);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const { dialog, output } = await t.open();
  await select(output, 0, 6);
  await page.evaluate(() => { (window as any).copyFixture.denied = true; });
  await dialog.getByRole('button', { name: 'Copy selection', exact: true }).tap();
  await expect(dialog.getByRole('status')).toContainText("device's Copy command");
  await expect(output).toHaveValue('output ready');
  expect(await output.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([0, 6]);
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
  await dialog.getByRole('button', { name: 'Copy all', exact: true }).tap();
  await expect(dialog).toBeVisible();
  expect(await writes(page)).toEqual([]);
  await page.routeWebSocket(/\/api\/v1\/terminal\//, ws => ws.close());
  t.disconnect();
  await expect(t.pane).toHaveAttribute('data-mode', 'disconnected');
  await select(output, 0, 6);
  await expect(dialog.getByRole('button', { name: 'Copy selection', exact: true })).toBeEnabled();
  await expect(output).toHaveValue('output ready');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(t.pane.locator('.xterm-helper-textarea')).not.toBeFocused();
  expect(t.input).toEqual([]); expect(errors).toEqual([]);
});

test('iOS Copy fits reduced-height screens in both themes without sending typed input', async ({ page }) => {
  const t = await terminal(page);
  const { dialog, output } = await t.open();
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const viewport of [{ width: 390, height: 420 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      await expect(dialog).toBeInViewport({ ratio: 1 });
      await expect(output).toBeInViewport({ ratio: 1 });
      await expect(dialog.getByRole('button', { name: 'Copy all', exact: true })).toBeInViewport({ ratio: 1 });
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    }
    await page.screenshot({ path: 'test-results/emachine-copy-output-' + theme + '.png' });
  }
  await output.focus(); await page.keyboard.type('must not reach shell'); await page.keyboard.press('Enter');
  await expect(output).toHaveValue('output ready'); expect(t.input).toEqual([]);
});

test('iOS Copy snapshots are discarded when a pane is hidden or disposed', async ({ page }) => {
  const t = await terminal(page);
  const { dialog, output } = await t.open();
  await page.getByRole('button', { name: 'beta on Test workstation, online', exact: true }).evaluate((element: HTMLButtonElement) => element.click());
  await expect(dialog).toBeHidden();
  await expect(output).toHaveValue('');
  await page.getByRole('button', { name: 'alpha on Test workstation, online', exact: true }).evaluate((element: HTMLButtonElement) => element.click());
  await expect(dialog).toBeHidden();
  await t.open();
  await page.goto('about:blank');
  expect(t.input).toEqual([]);
});

test('clipboard denial after switching terminals stays with the originating pane', async ({ page }) => {
  const t = await terminal(page);
  const point = await cell(t.pane, 'output ready', 8);
  await page.mouse.dblclick(point.x, point.y);
  await page.evaluate(() => {
    navigator.clipboard.writeText = () => new Promise((_, reject) => { (window as any).denyCopy = reject; });
  });
  await t.pane.getByRole('button', { name: 'Copy', exact: true }).tap();
  await page.getByRole('button', { name: 'beta on Test workstation, online', exact: true }).evaluate((button: HTMLButtonElement) => button.click());
  await page.evaluate(() => (window as any).denyCopy(new DOMException('Denied', 'NotAllowedError')));
  expect(await page.locator('.toast-region').innerText()).not.toContain('Clipboard access was not granted');
  await expect(page.getByRole('dialog', { name: 'Copy terminal output' })).not.toBeVisible();
});
