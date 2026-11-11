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
async function snapshotRange(output: Locator, start: number, end: number) {
  return output.evaluateHandle((pre, { start, end }) => {
    // Resolve logical UTF-16 offsets across any number of styled text runs.
    const boundary = (offset: number): [Text, number] => {
      const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
        if (offset <= node.length) return [node, offset];
        offset -= node.length;
      }
      throw new RangeError('Offset outside terminal output');
    };
    const range = document.createRange(); range.setStart(...boundary(start)); range.setEnd(...boundary(end));
    return range;
  }, { start, end });
}

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

for (const theme of ['dark', 'light']) test(`iOS native handoff preserves terminal colors and formatting in ${theme} mode`, async ({ page, browserName }, testInfo) => {
  const t = await terminal(page);
  if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: /^Theme:/ }).tap();
  t.send(JSON.stringify({ type: 'state', mode: 'observe', cols: 32, rows: 12 }));
  await expect(t.pane).toHaveAttribute('data-mode', 'observe');
  const history = Array.from({ length: 24 }, (_, i) => 'history ' + i);
  t.send(Buffer.from('\u001b[2J\u001b[3J\u001b[H\u001b[?25l' + [
    ...history,
    '   \u001b[1;3;4;38;2;255;226;75;48;2;57;30;111mStyled wide \u754c   \u001b[0m',
    '      \u001b[38;5;23;48;5;221;7mAligned column \u2590\u259b\u2588\u259c\u258c\u001b[0m tail',
    'tap target', 'ready',
  ].join('\r\n')));
  const rows = t.pane.locator('.xterm-rows');
  const row = rows.locator(':scope > div').filter({ hasText: 'Styled wide' });
  await expect(row).toBeVisible();
  await expect(rows).not.toContainText('history 0');
  const box = (await row.boundingBox())!;
  // Compare the same screen pixels for two unselected rows. The cursor, handles and controls are outside this crop.
  const clip = { x: Math.ceil(box.x), y: Math.ceil(box.y), width: Math.floor(box.width) - 1, height: Math.floor(box.height * 2) - 1 };
  const capture = (path?: string) => page.screenshot({ path, clip, scale: 'css', animations: 'disabled', caret: 'hide' });
  const before = await capture(testInfo.outputPath('live.png'));
  await hold(page, browserName, t.pane, await cell(t.pane, 'tap target', 6));
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe('target');
  const frozen = await capture(testInfo.outputPath('frozen.png'));
  if (!frozen.equals(before)) {
    await testInfo.attach('live.png', { body: before, contentType: 'image/png' });
    await testInfo.attach('frozen.png', { body: frozen, contentType: 'image/png' });
  }
  expect(frozen.equals(before), 'the frozen rows match the live renderer at their original coordinates').toBe(true);
  const snapshot = t.pane.locator('.terminal-native-selection pre');
  const original = await snapshot.evaluate(pre => {
    const range = document.createRange(); range.selectNodeContents(pre); return range.toString();
  });
  expect(original).toContain('Aligned column \u2590\u259b\u2588\u259c\u258c');
  t.send(Buffer.from('\u001b[2J\u001b[Hnew frame'));
  await expect(rows).toContainText('new frame');
  expect((await capture()).equals(before), 'live redraws cannot change the frozen formatting').toBe(true);
  expect(t.input).toEqual([]);
});

test('iOS native handoff preserves styled scrollback and concealed cells', async ({ page, browserName }) => {
  const t = await terminal(page);
  t.send(JSON.stringify({ type: 'state', mode: 'observe', cols: 32, rows: 10 }));
  await expect(t.pane).toHaveAttribute('data-mode', 'observe');
  const rows = t.pane.locator('.xterm-rows');
  t.send(Buffer.from('\u001b[2J\u001b[3J\u001b[H\u001b[?25l\u001b[1;31;44mold \u001b[8mhidden\u001b[28m end\u001b[0m'));
  await expect(rows).toContainText(' end');
  await expect(rows).not.toContainText('hidden');
  const first = (await rows.locator(':scope > div').first().boundingBox())!;
  const clip = { x: Math.ceil(first.x), y: Math.ceil(first.y), width: Math.floor(first.width) - 1, height: Math.floor(first.height) - 1 };
  const capture = () => page.screenshot({ clip, scale: 'css', animations: 'disabled', caret: 'hide' });
  const before = await capture();
  const history = Array.from({ length: 1000 }, (_, i) => 'filler ' + i);
  t.send(Buffer.from('\r\n' + [...history, 'tap target'].join('\r\n')));
  await expect(rows).toContainText('tap target');
  await expect(rows).not.toContainText('old ');
  await hold(page, browserName, t.pane, await cell(t.pane, 'tap target', 6));
  const snapshot = t.pane.locator('.terminal-native-selection pre');
  // The frozen row must survive replacement of both its live buffer and the palette used to paint it.
  await expect(snapshot.locator('.terminal-native-placeholder').filter({ hasText: 'old hidden end' })).toHaveCount(1);
  t.send(Buffer.from('\u001b]4;1;rgb:22/ff/22;4;rgb:55/00/55\u0007\u001b[2J\u001b[3J\u001b[H\u001b[31;44mlive palette\u001b[0m'));
  await expect(rows.locator('span').filter({ hasText: 'live palette' }).first()).toHaveCSS('background-color', 'rgb(85, 0, 85)');
  const original = ['old hidden end', ...history, 'tap target'].join('\n');
  const all = await snapshot.evaluate(pre => {
    const selection = document.getSelection()!; selection.selectAllChildren(pre);
    return { native: selection.toString(), dom: selection.getRangeAt(0).toString() };
  });
  expect(all.dom).toBe(original);
  expect(all.native).toBe(original);
  expect(await snapshot.evaluate(pre => pre.scrollTop)).toBeGreaterThan(0);
  const concealed = await snapshotRange(snapshot, 4, 10);
  await concealed.evaluate(range => {
    document.getSelection()!.setBaseAndExtent(range.endContainer, range.endOffset, range.startContainer, range.startOffset);
  });
  await snapshot.evaluate(pre => { pre.scrollTop = 0; });
  await expect(snapshot.locator('.terminal-native-row').filter({ hasText: 'old hidden end' }).locator('span').first()).toBeInViewport();
  expect(await page.evaluate(() => {
    const selection = document.getSelection()!, range = selection.getRangeAt(0);
    return { text: selection.toString(), reversed: selection.anchorNode === range.endContainer && selection.anchorOffset === range.endOffset };
  })).toEqual({ text: 'hidden', reversed: true });
  await t.pane.getByRole('button', { name: 'Copy', exact: true }).tap();
  await expect.poll(() => writes(page)).toEqual(['hidden']);
  // Match the original unselected pixels after verifying the restored handles and copy bytes.
  await page.evaluate(() => document.getSelection()!.removeAllRanges());
  await expect.poll(async () => (await capture()).equals(before), {
    message: 'the old row retains its original palette, glyphs and concealment after a live palette change and history clear', timeout: 3000,
  }).toBe(true);
  expect(t.input).toEqual([]);
});

test('iOS native handoff preserves a horizontally scrolled observer grid', async ({ page, browserName }) => {
  const t = await terminal(page);
  t.send(JSON.stringify({ type: 'state', mode: 'observe', cols: 100, rows: 12 }));
  await expect(t.pane).toHaveAttribute('data-mode', 'observe');
  t.send(Buffer.from('\u001b[2J\u001b[3J\u001b[H\u001b[?25l\u001b[4;72H\u001b[1;33;44mposition check\u001b[0m\u001b[7;72H\u001b[3mtap target\u001b[0m'));
  const rows = t.pane.locator('.xterm-rows');
  await expect(rows).toContainText('tap target');
  const host = t.pane.locator('.terminal-host');
  expect(await host.evaluate(el => { el.scrollLeft = el.scrollWidth; return el.scrollLeft; })).toBeGreaterThan(0);
  const marker = (await rows.locator('span').filter({ hasText: /^position check$/ }).first().boundingBox())!;
  const clip = { x: Math.ceil(marker.x), y: Math.ceil(marker.y), width: Math.floor(marker.width) - 1, height: Math.floor(marker.height) - 1 };
  const capture = () => page.screenshot({ clip, scale: 'css', animations: 'disabled', caret: 'hide' });
  const before = await capture();
  await hold(page, browserName, t.pane, await cell(t.pane, 'tap target', 6));
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe('target');
  expect((await capture()).equals(before), 'the scrolled column stays at its screen coordinates').toBe(true);
  expect(t.input).toEqual([]);
});

test('iOS native handoff selects the exact wrapped occurrence and copies an adjusted browser range', async ({ page, browserName }) => {
  const t = await terminal(page);
  t.send(JSON.stringify({ type: 'state', mode: 'observe', cols: 20, rows: 10 }));
  await expect(t.pane).toHaveAttribute('data-mode', 'observe');
  const word = 'abcd\u754ce\u0301f';
  const history = Array.from({ length: 35 }, (_, index) => 'history ' + index);
  const prefix = [...history, 'first ' + word, ' '.repeat(15)].join('\n');
  const output = prefix + word + '\nnext row';
  t.send(Buffer.from('\u001b[2J\u001b[3J\u001b[H' + output.replaceAll('\n', '\r\n')));
  const rows = t.pane.locator('.xterm-rows');
  await expect(rows).toContainText('next row');
  const wrapped = rows.locator(':scope > div').filter({ hasText: '\u754ce\u0301f' }).last();
  await expect(wrapped).not.toContainText('abcd');
  const row = (await wrapped.boundingBox())!, screen = (await t.pane.locator('.xterm-screen').boundingBox())!;
  await hold(page, browserName, t.pane, { x: screen.x + 1.5 * screen.width / 20, y: row.y + row.height / 2 });
  const selected = () => page.evaluate(() => document.getSelection()?.toString());
  await expect.poll(selected, { timeout: 3000 }).toBe(word);
  t.send(Buffer.from('\r\nnew output'));
  await expect(rows).toContainText('new output');
  const snapshot = t.pane.locator('.terminal-native-selection pre');
  const inspection = await snapshot.evaluate(pre => {
    const selection = document.getSelection()!, range = selection.getRangeAt(0);
    const prefix = document.createRange(); prefix.selectNodeContents(pre); prefix.setEnd(range.startContainer, range.startOffset);
    const bounds = range.getClientRects()[0];
    const hit = bounds && document.elementFromPoint(bounds.left + 1, bounds.top + bounds.height / 2);
    const target = hit ?? pre;
    return {
      text: pre.textContent, offset: prefix.toString().length, editable: (target as HTMLElement).isContentEditable,
      reachable: hit !== null && pre.contains(hit), selectable: getComputedStyle(pre).userSelect,
      menu: target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
      drag: target.dispatchEvent(new Event('touchmove', { bubbles: true, cancelable: true })),
    };
  });
  expect(inspection).toEqual({ text: output, offset: prefix.length, editable: false, reachable: true, selectable: 'text', menu: true, drag: true });
  const extended = await snapshotRange(snapshot, prefix.length, prefix.length + word.length + '\nnext'.length);
  await extended.evaluate(range => {
    const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  });
  await expect.poll(selected).toBe(word + '\nnext');
  const copy = t.pane.getByRole('button', { name: 'Copy', exact: true });
  await copy.tap();
  await expect.poll(() => writes(page)).toEqual([word + '\nnext']);
  // Target the final word by geometry. The browser's pointer handling must create this new selection.
  const lastWord = await snapshotRange(snapshot, output.length - 3, output.length);
  const point = await lastWord.evaluate(range => {
    const rect = range.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.dblclick(point.x, point.y);
  await expect.poll(selected, { timeout: 3000 }).toBe('row');
  await copy.tap();
  await expect.poll(() => writes(page)).toEqual([word + '\nnext', 'row']);
  await expect(t.pane.locator('.xterm-helper-textarea')).not.toBeFocused();
  expect(t.input).toEqual([]);
});

test('iOS native handoff clips a selection crossing the instructions to the output', async ({ page, browserName }) => {
  const t = await terminal(page);
  await hold(page, browserName, t.pane, await cell(t.pane, 'output ready', 8));
  const view = t.pane.getByRole('region', { name: 'Select terminal text', exact: true });
  const hint = t.pane.locator('.terminal-selection-bar span');
  await expect.soft(hint).toHaveCSS('user-select', 'none', { timeout: 1000 });
  const inside = await snapshotRange(view.locator('pre'), 'output '.length, 'output ready'.length);
  await inside.evaluate(range => {
    const outside = range.startContainer.parentElement!.closest('.terminal-pane')!.querySelector('.terminal-selection-bar span')!.firstChild!;
    document.getSelection()!.setBaseAndExtent(range.startContainer, range.startOffset, outside, outside.textContent!.length);
  });
  await t.pane.getByRole('button', { name: 'Copy', exact: true }).tap();
  await expect.poll(() => writes(page), { timeout: 3000 }).toEqual(['ready']);
  expect(t.input).toEqual([]);
});

for (const width of [390, 1100]) test(`iOS native handoff ends on Done and is discarded when switching terminals at ${width}px`, async ({ page, browserName }) => {
  await page.setViewportSize({ width, height: 844 });
  const t = await terminal(page, 'MacIntel');
  const done = t.pane.getByRole('button', { name: 'Done selecting', exact: true });
  const copy = t.pane.getByRole('button', { name: 'Copy', exact: true });
  const controls = t.pane.locator('.terminal-keyboard-controls');
  const host = t.pane.locator('.terminal-host');
  const shortcut = t.pane.getByRole('button', { name: 'Ctrl-O', exact: true });
  if (width === 1100) await expect(shortcut).toBeInViewport({ ratio: 1 });
  const shortcutBox = width === 1100 ? (await shortcut.boundingBox())! : undefined;
  const hostBefore = await host.boundingBox();
  const start = await cell(t.pane, 'output ready', 8);
  await hold(page, browserName, t.pane, start);
  await expect(done).toBeVisible({ timeout: 3000 });
  await expect(done).toBeInViewport({ ratio: 1 });
  await expect(copy).toBeInViewport({ ratio: 1 });
  await expect(controls).toHaveJSProperty('inert', true);
  expect(await host.boundingBox()).toEqual(hostBefore);
  await copy.tap();
  await expect.poll(() => writes(page)).toEqual(['ready']);
  if (shortcutBox) {
    // Relocated key combinations must remain inactive while the frozen selection is open.
    await page.touchscreen.tap(shortcutBox.x + shortcutBox.width / 2, shortcutBox.y + shortcutBox.height / 2);
    await expect(done).toBeVisible();
    expect(t.input).toEqual([]);
  }
  await done.tap();
  await expect(done).toBeHidden();
  await expect(controls).toHaveJSProperty('inert', false);
  expect(await page.evaluate(() => document.getSelection()?.toString())).toBe('');
  await expect(t.pane.locator('.xterm-helper-textarea')).not.toBeFocused();
  await hold(page, browserName, t.pane, await cell(t.pane, 'output ready', 8));
  await expect(done).toBeVisible();
  await page.getByRole('button', { name: 'beta on Test workstation, online', exact: true }).evaluate((button: HTMLButtonElement) => button.click());
  await expect(done).toBeHidden();
  await page.getByRole('button', { name: 'alpha on Test workstation, online', exact: true }).evaluate((button: HTMLButtonElement) => button.click());
  await expect(done).toBeHidden();
  expect(await page.evaluate(() => document.getSelection()?.toString())).toBe('');
  expect(t.input).toEqual([]);
});

test('non-iOS touch keeps the live selection without a native handoff', async ({ page, browserName }) => {
  const t = await terminal(page, 'Linux aarch64');
  await hold(page, browserName, t.pane, await cell(t.pane, 'output ready', 8));
  await expect(t.pane.getByRole('button', { name: 'Done selecting' })).toBeHidden();
  expect(await page.evaluate(() => document.getSelection()?.toString())).toBe('');
  await t.pane.getByRole('button', { name: 'Copy', exact: true }).tap();
  await expect.poll(() => writes(page)).toEqual(['ready']);
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
