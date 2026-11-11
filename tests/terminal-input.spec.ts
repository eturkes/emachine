import { test, expect, type Locator, type Page } from '@playwright/test';
// @ts-expect-error This JavaScript fixture drives the real native server.
import { fixture } from './network-helper.mjs';
// @ts-expect-error This fixture records input inside a real manual zmx attachment.
import { manualInputRecorder } from './terminal-session-fixture.mjs';

let machine: any;
test.beforeAll(async () => { machine = await fixture(); });
test.afterAll(async () => { await machine?.close(); });

async function inputPlatform(page: Page, platform = 'iPhone') {
  await page.addInitScript(platform => {
    const mobile = platform === 'iPhone' || platform === 'MacIntel';
    Object.defineProperty(navigator, 'platform', { configurable: true, value: platform });
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: mobile ? 5 : 0 });
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: platform === 'iPhone'
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'
      : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15' });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      readText: async () => 'paste\ntext', writeText: async () => {},
    } });
  }, platform);
}

async function terminal(page: Page, platform = 'iPhone') {
  const input: string[] = [];
  let send!: (data: string | Buffer) => void;
  let disconnect!: () => void;
  await inputPlatform(page, platform);
  await page.routeWebSocket(/\/api\/v1\/terminal\//, ws => {
    send = data => ws.send(data);
    disconnect = () => ws.close();
    ws.onMessage(data => { if (Buffer.isBuffer(data)) input.push(data.toString()); });
    send(JSON.stringify({ type: 'state', mode: 'control', session: 'input-fixture', cols: 80, rows: 24 }));
    send(Buffer.from('input ready\r\n'));
  });
  await page.goto(machine.origin);
  const pane = page.locator('.terminal-pane:not([hidden])');
  await expect(pane).toHaveAttribute('data-mode', 'control');
  await expect(pane.locator('.xterm-rows')).toContainText('input ready');
  const textarea = pane.locator('.xterm-helper-textarea');
  await textarea.focus();
  return { input, send, disconnect, pane, textarea };
}

async function openText(pane: Locator) {
  const toggle = pane.getByRole('button', { name: 'Text', exact: true });
  expect(await toggle.count()).toBe(1);
  await toggle.click();
  const text = pane.getByRole('textbox', { name: 'Terminal text', exact: true });
  await expect(text).toBeFocused();
  return { toggle, text, send: pane.getByRole('button', { name: 'Send text', exact: true }) };
}

// Model the soft keyboard's edit stream, not desktop keydown autorepeat.
async function deleteInput(textarea: Locator, count = 1, inputType = 'deleteContentBackward') {
  return textarea.evaluate((element: HTMLTextAreaElement, { count, inputType }) => {
    const edits = [];
    for (let i = 0; i < count; i++) {
      const before = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType, composed: true });
      element.dispatchEvent(before);
      const start = element.selectionStart, end = element.selectionEnd;
      const editable = start > 0 || end > start;
      edits.push({ cancelled: before.defaultPrevented, editable });
      if (before.defaultPrevented || !editable) break;
      element.setRangeText('', Math.max(0, start - 1), end, 'end');
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType, composed: true }));
    }
    return edits;
  }, { count, inputType });
}

for (const platform of ['Linux x86_64', 'iPhone']) test.describe(`responsive terminal toolbar on ${platform}`, () => {
  test.use({ viewport: { width: 1800, height: 900 }, isMobile: platform === 'iPhone', hasTouch: platform === 'iPhone' });

  test('terminal toolbar distributes whole groups across available rows', async ({ page }, testInfo) => {
    await page.route(/\/api\/v1\/projects\/[^/]+\/prompt-history(?:\?.*)?$/, route => route.fulfill({ json: { prompts: [], nextCursor: null } }));
    const t = await terminal(page, platform);
    await expect(t.pane.getByRole('group', { name: 'Common keys', exact: true }).getByRole('button')).toHaveText(['Esc', 'Tab', 'Enter', 'Copy', 'Paste']);
    const textTools = t.pane.getByRole('group', { name: 'Text tools', exact: true });
    await expect(textTools).toHaveCount(platform === 'iPhone' ? 1 : 0);
    if (platform === 'iPhone') await expect(textTools.getByRole('button')).toHaveText(['Text']);
    const mounted = await t.pane.locator('.xterm').elementHandle();
    const geometry = () => t.pane.evaluate(element => {
      const toolbar = element.querySelector<HTMLElement>('.terminal-toolbar')!;
      const box = toolbar.getBoundingClientRect();
      const buttons = Array.from(toolbar.querySelectorAll<HTMLButtonElement>('button')).filter(button => {
        const rect = button.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && getComputedStyle(button).visibility !== 'hidden';
      });
      const rectangles = buttons.map(button => button.getBoundingClientRect());
      const tops: number[] = [];
      for (const rect of rectangles) if (!tops.some(top => Math.abs(top - rect.top) < 2)) tops.push(rect.top);
      const key = (label: string) => toolbar.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.getBoundingClientRect();
      const group = (name: string) => {
        const items = Array.from(toolbar.querySelectorAll<HTMLButtonElement>(`[role="group"][aria-label="${name}"] button`)).map(button => button.getBoundingClientRect());
        return { top: items[0].top, left: items[0].left, right: items.at(-1)!.right, sameRow: items.every(rect => Math.abs(rect.top - items[0].top) < 2) };
      };
      const navigation = group('Navigation'), shortcuts = group('Key combinations');
      const groupNames = ['Common keys', 'Navigation', 'Key combinations', 'Prompt tools'];
      if (toolbar.querySelector('[role="group"][aria-label="Text tools"]')) groupNames.push('Text tools');
      return {
        rows: tops.length,
        contained: rectangles.every(rect => rect.left >= box.left - 1 && rect.right <= box.right + 1 && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1),
        overflow: Array.from(toolbar.querySelectorAll<HTMLElement>('.terminal-keys, .terminal-tools')).some(part => part.clientWidth > 0 && part.scrollWidth > part.clientWidth + 1),
        pageOverflow: document.documentElement.scrollWidth > innerWidth,
        groupsIntact: groupNames.every(name => group(name).sameRow),
        commonTop: key('Esc').top, shortcutTop: shortcuts.top,
        groupGap: navigation.left - key('Paste').right, buttonGap: key('↓').left - key('↑').right,
        copyGap: key('Copy').left - key('Enter').right, pasteGap: key('Paste').left - key('Copy').right,
        shortcutCenter: ((shortcuts.left + shortcuts.right) / 2 - box.left) / box.width,
        width: box.width,
      };
    });
    const expectRows = async (rows: number) => {
      await expect.poll(async () => {
        const layout = await geometry();
        return { rows: layout.rows, contained: layout.contained, overflow: layout.overflow, pageOverflow: layout.pageOverflow, groupsIntact: layout.groupsIntact };
      }).toEqual({ rows, contained: true, overflow: false, pageOverflow: false, groupsIntact: true });
      return geometry();
    };
    const expectWide = async () => {
      const layout = await expectRows(1);
      expect(layout.groupGap).toBeGreaterThan(layout.buttonGap + 24);
      expect(layout.copyGap).toBeCloseTo(layout.buttonGap, 3);
      expect(layout.pasteGap).toBeCloseTo(layout.buttonGap, 3);
      expect(layout.shortcutCenter).toBeGreaterThan(0.4);
      expect(layout.shortcutCenter).toBeLessThan(0.7);
    };
    await expectRows(1);
    for (const width of [1100, 1024]) {
      await page.setViewportSize({ width, height: 768 });
      if (width === 1100) {
        const layout = await expectRows(2);
        expect(layout.shortcutTop).toBeGreaterThan(layout.commonTop + 20);
      } else {
        // At tablet widths, larger iOS targets may still need the compact two-row fallback.
        await expect.poll(async () => {
          const layout = await geometry();
          return { rows: layout.rows, pageOverflow: layout.pageOverflow, groupsIntact: layout.groupsIntact };
        }).toEqual({ rows: 2, pageOverflow: false, groupsIntact: true });
        for (const button of await t.pane.locator('.terminal-tools button').all()) await expect(button).toBeInViewport({ ratio: 1 });
      }
      await page.screenshot({ path: testInfo.outputPath(`toolbar-${platform === 'iPhone' ? 'ios' : 'desktop'}-${width}.png`) });
    }
    // A narrow scroller's old offset must not hide buttons when full groups fit again.
    await page.setViewportSize({ width: 390, height: 420 });
    await expect.poll(() => t.pane.locator('.terminal-keys').evaluate(element => {
      element.scrollLeft = element.scrollWidth;
      return element.scrollLeft;
    })).toBeGreaterThan(0);
    await page.setViewportSize({ width: 1800, height: 900 });
    await expectWide();
    await page.screenshot({ path: testInfo.outputPath(`toolbar-${platform === 'iPhone' ? 'ios' : 'desktop'}-wide.png`) });
    await page.getByRole('button', { name: 'Collapse project sidebar', exact: true }).click();
    await page.setViewportSize({ width: 1300, height: 900 });
    const beforeHistory = await expectRows(1);
    await t.pane.getByRole('button', { name: 'History', exact: true }).click();
    const history = t.pane.getByRole('complementary', { name: 'Prompt history', exact: true });
    await expect(history).toBeVisible();
    const withHistory = await expectRows(2);
    expect(withHistory.width).toBeLessThan(beforeHistory.width);
    expect(withHistory.shortcutTop).toBeGreaterThan(withHistory.commonTop + 20);
    await history.getByRole('button', { name: 'Collapse prompt history', exact: true }).click();
    await expectRows(1);
    expect(await mounted!.evaluate(element => element === document.querySelector('.terminal-pane:not([hidden]) .xterm'))).toBe(true);
    t.send(Buffer.from('toolbar resize output continues\r\n'));
    await expect(t.pane.locator('.xterm-rows')).toContainText('toolbar resize output continues');
    expect(t.input).toEqual([]);
  });
});

test.describe('terminal input', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  for (const platform of ['iPhone', 'MacIntel']) test(`compact terminal on ${platform} keeps a zoom-safe input across rotation and observation`, async ({ page }) => {
    const t = await terminal(page, platform);
    for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1024, height: 768 }]) {
      await page.setViewportSize(viewport);
      await expect(t.pane.locator('.xterm-rows')).toHaveCSS('font-size', '12px');
      await expect(t.textarea).toHaveCSS('font-size', '16px');
      await expect(t.pane).toHaveCSS('touch-action', 'manipulation');
      await t.textarea.focus();
      await page.keyboard.press('ArrowRight');
      await expect(t.textarea).toHaveCSS('font-size', '16px');
    }
    t.send(JSON.stringify({ type: 'state', mode: 'observe', cols: 80, rows: 24 }));
    await expect(t.pane).toHaveAttribute('data-mode', 'observe');
    await page.setViewportSize({ width: 390, height: 420 });
    await expect(t.pane.locator('.xterm-rows')).toHaveCSS('font-size', '12px');
    await expect(t.pane.locator('.xterm-rows > div')).toHaveCount(24);
    await expect(t.textarea).toHaveCSS('font-size', '16px');
    expect(await page.locator('meta[name="viewport"]').getAttribute('content')).not.toMatch(/user-scalable\s*=\s*no|maximum-scale\s*=\s*1(?:\D|$)/);
    await expect.poll(() => t.input.join('')).toBe('\u001b[C'.repeat(3));
  });

  test('Keyboard toggles terminal input with touch and keyboard activation', async ({ page }) => {
    const t = await terminal(page), keyboard = t.pane.locator('.terminal-keyboard');
    await keyboard.tap();
    await expect(t.textarea).not.toBeFocused();
    await expect(keyboard).toHaveAttribute('aria-pressed', 'false');
    await keyboard.tap();
    await expect(t.textarea).toBeFocused();
    await expect(keyboard).toHaveAttribute('aria-pressed', 'true');
    expect(await keyboard.evaluate((element: HTMLButtonElement) => {
      element.click();
      return document.activeElement === element.closest('.terminal-pane')!.querySelector('.xterm-helper-textarea');
    })).toBe(false);
    for (const key of ['Enter', 'Space']) {
      await keyboard.focus();
      await page.keyboard.press(key);
      await expect(t.textarea).toBeFocused();
      await expect(keyboard).toHaveAttribute('aria-pressed', 'true');
      await keyboard.tap();
      await expect(t.textarea).not.toBeFocused();
      await expect(keyboard).toHaveAttribute('aria-pressed', 'false');
    }
    expect(t.input).toEqual([]);
  });

  test('toolbar arrows and Ctrl-O/E reach a manual-led zmx session byte-for-byte', async ({ page }) => {
    const shared = await fixture();
    let manual: any;
    try {
      manual = await manualInputRecorder(shared);
      await expect.poll(() => manual.text).toContain('INPUT RECORDER READY');
      await inputPlatform(page);
      await page.goto(shared.origin);
      const pane = page.locator('.terminal-pane:not([hidden])');
      await expect(pane).toHaveAttribute('data-mode', 'control');
      await expect(pane.locator('.xterm-rows')).toContainText('INPUT RECORDER READY');
      const textarea = pane.locator('.xterm-helper-textarea'), keyboard = pane.locator('.terminal-keyboard');
      let expected = '';
      await expect.poll(() => manual.read()).toBe(expected);
      for (const shown of [false, true]) {
        await textarea.focus();
        if (!shown) await keyboard.tap();
        for (const [name, sequence] of [['\u2191', '\u001b[A'], ['\u2193', '\u001b[B'], ['\u2190', '\u001b[D'], ['\u2192', '\u001b[C']] as const) {
          // The other attachment takes leadership before every first phone arrow.
          manual.input('m'); expected += 'm';
          await expect.poll(() => manual.read()).toBe(expected);
          await pane.getByRole('button', { name, exact: true }).tap(); expected += sequence;
          await expect.poll(() => manual.read()).toBe(expected);
          await expect(keyboard).toHaveAttribute('aria-pressed', String(shown));
          if (shown) await expect(textarea).toBeFocused();
          else await expect(textarea).not.toBeFocused();
        }
      }
      for (const [name, sequence] of [['Ctrl-O', '\u000f'], ['Ctrl-E', '\u0005']] as const) {
        manual.input('m'); expected += 'm';
        await expect.poll(() => manual.read()).toBe(expected);
        const shortcut = pane.getByRole('button', { name, exact: true });
        await shortcut.scrollIntoViewIfNeeded();
        await shortcut.tap(); expected += sequence;
        await expect.poll(() => manual.read()).toBe(expected);
        await expect(textarea).toBeFocused();
      }
      await textarea.focus();
      await page.keyboard.type('a');
      await pane.getByRole('button', { name: '\u2190', exact: true }).tap();
      await page.keyboard.type('b');
      await pane.getByRole('button', { name: '\u2192', exact: true }).tap();
      await pane.getByRole('button', { name: 'Enter', exact: true }).tap();
      await expect.poll(() => manual.read()).toBe(expected + 'a\u001b[Db\u001b[C\r');
    } finally {
      await page.goto('about:blank');
      await manual?.close();
      await shared.close();
    }
  });

  test('toolbar arrows preserve the hidden or open terminal keyboard while navigating a selector', async ({ page }) => {
    const t = await terminal(page), keyboard = t.pane.locator('.terminal-keyboard');
    const up = t.pane.getByRole('button', { name: '\u2191', exact: true });
    const down = t.pane.getByRole('button', { name: '\u2193', exact: true });
    const expected: string[] = [];
    await keyboard.tap();
    await expect(t.textarea).not.toBeFocused();
    await expect(keyboard).toHaveAttribute('aria-pressed', 'false');
    for (const [arrow, sequence] of [[down, '\u001b[B'], [up, '\u001b[A'], [down, '\u001b[B']] as const) {
      await arrow.tap(); expected.push(sequence);
      await expect.poll(() => t.input).toEqual(expected);
      await expect(t.textarea).not.toBeFocused();
      await expect(keyboard).toHaveAttribute('aria-pressed', 'false');
    }
    await keyboard.tap();
    await expect(t.textarea).toBeFocused();
    for (const [arrow, sequence] of [[up, '\u001b[A'], [down, '\u001b[B']] as const) {
      await arrow.tap(); expected.push(sequence);
      await expect.poll(() => t.input).toEqual(expected);
      await expect(t.textarea).toBeFocused();
      await expect(keyboard).toHaveAttribute('aria-pressed', 'true');
    }
  });

  test('toolbar arrows preserve native keyboard dismissal without refocusing the raw helper', async ({ page }) => {
    const t = await terminal(page), keyboard = t.pane.locator('.terminal-keyboard');
    const resize = async (height: number) => page.evaluate(height => {
      Object.defineProperties(visualViewport!, {
        height: { configurable: true, value: height }, scale: { configurable: true, value: 1 },
      });
      visualViewport!.dispatchEvent(new Event('resize'));
    }, height);
    await resize(480);
    await expect(keyboard).toHaveAttribute('aria-pressed', 'true');
    await resize(844);
    await expect(t.textarea).toBeFocused();
    await expect(keyboard).toHaveAttribute('aria-pressed', 'false');
    await t.textarea.evaluate((element: HTMLTextAreaElement) => {
      const focus = element.focus.bind(element);
      element.dataset.focusCalls = '0';
      // A redundant focus() may reopen the native keyboard without emitting a focus event.
      element.focus = options => { element.dataset.focusCalls = String(Number(element.dataset.focusCalls) + 1); focus(options); };
    });
    const expected: string[] = [];
    for (const [name, sequence] of [['\u2191', '\u001b[A'], ['\u2193', '\u001b[B']] as const) {
      await t.pane.getByRole('button', { name, exact: true }).tap(); expected.push(sequence);
      await expect.poll(() => t.input).toEqual(expected);
      await expect(t.textarea).toHaveAttribute('data-focus-calls', '0');
      await expect(t.textarea).toBeFocused();
      await expect(keyboard).toHaveAttribute('aria-pressed', 'false');
    }
  });

  test('toolbar arrows follow cursor modes once per tap and hardware modifiers remain native', async ({ page }) => {
    const t = await terminal(page);
    const down = t.pane.getByRole('button', { name: '\u2193', exact: true });
    const expected: string[] = [];
    for (const application of [false, true, false]) {
      const label = application ? 'APPLICATION CURSOR' : `NORMAL CURSOR ${expected.length}`;
      t.send(Buffer.from(`\u001b[?1${application ? 'h' : 'l'}${label}\r\n`));
      await expect(t.pane.locator('.xterm-rows')).toContainText(label);
      const prefix = application ? '\u001bO' : '\u001b[';
      for (const [name, suffix] of [['\u2191', 'A'], ['\u2193', 'B'], ['\u2190', 'D'], ['\u2192', 'C']] as const) {
        await t.pane.getByRole('button', { name, exact: true }).tap(); expected.push(prefix + suffix);
        await expect.poll(() => t.input).toEqual(expected);
      }
      await t.textarea.focus();
      for (const [key, value] of [['Control+ArrowUp', '\u001b[1;5A'], ['Alt+ArrowDown', '\u001b[1;3B'], ['Control+Alt+ArrowUp', '\u001b[1;7A']]) {
        await page.keyboard.press(key); expected.push(value);
        await expect.poll(() => t.input).toEqual(expected);
      }
      await down.tap(); expected.push(prefix + 'B');
      await expect.poll(() => t.input).toEqual(expected);
    }
  });

  test('toolbar arrows drop observer and disconnected navigation without replaying it after control returns', async ({ page }) => {
    const t = await terminal(page);
    const up = t.pane.getByRole('button', { name: '\u2191', exact: true });
    const down = t.pane.getByRole('button', { name: '\u2193', exact: true });
    await down.tap();
    await expect.poll(() => t.input).toEqual(['\u001b[B']);
    t.send(JSON.stringify({ type: 'state', mode: 'observe', cols: 80, rows: 24 }));
    await expect(t.pane).toHaveAttribute('data-mode', 'observe');
    await up.tap(); await down.tap();
    t.send(JSON.stringify({ type: 'state', mode: 'control', cols: 80, rows: 24 }));
    await expect(t.pane).toHaveAttribute('data-mode', 'control');
    await down.tap();
    await expect.poll(() => t.input).toEqual(['\u001b[B', '\u001b[B']);
    t.disconnect();
    await expect(t.pane).toHaveAttribute('data-mode', 'disconnected');
    await down.tap();
    await expect(t.pane).toHaveAttribute('data-mode', 'control');
    await up.tap();
    await expect.poll(() => t.input).toEqual(['\u001b[B', '\u001b[B', '\u001b[A']);
  });

  test('Keyboard follows native dismissal while preserving input focus and intentional pinch', async ({ page }) => {
    const t = await terminal(page), keyboard = t.pane.locator('.terminal-keyboard');
    const resize = async (height: number, scale = 1) => page.evaluate(({ height, scale }) => {
      Object.defineProperties(visualViewport!, {
        height: { configurable: true, value: height }, scale: { configurable: true, value: scale },
      });
      visualViewport!.dispatchEvent(new Event('resize'));
    }, { height, scale });
    await resize(480);
    await expect(keyboard).toHaveAttribute('aria-pressed', 'true');
    await resize(240, 2);
    await expect(keyboard).toHaveAttribute('aria-pressed', 'true');
    await resize(422, 2);
    await expect(t.textarea).toBeFocused();
    await expect(keyboard).toHaveAttribute('aria-pressed', 'false');
    expect(await keyboard.evaluate((element: HTMLButtonElement) => {
      const input = element.closest('.terminal-pane')!.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')!;
      let focuses = 0;
      const focused = () => { focuses++; };
      input.addEventListener('focus', focused);
      element.click();
      input.removeEventListener('focus', focused);
      return { focuses, focused: document.activeElement === input, pressed: element.getAttribute('aria-pressed') };
    })).toEqual({ focuses: 1, focused: true, pressed: 'true' });
    // Pinch alone must not reset the explicit toggle when no docked keyboard was detected.
    await resize(844);
    await expect(keyboard).toHaveAttribute('aria-pressed', 'true');
    await keyboard.tap();
    await expect(t.textarea).not.toBeFocused();
    await expect(keyboard).toHaveAttribute('aria-pressed', 'false');
    expect(t.input).toEqual([]);
  });

  test('Esc and Tab scroll with terminal keys while Keyboard stays pinned', async ({ page }, testInfo) => {
    const t = await terminal(page);
    const keyboard = t.pane.locator('.terminal-keyboard');
    const keys = t.pane.locator('.terminal-keys');
    const escape = t.pane.getByRole('button', { name: 'Esc', exact: true });
    const tab = t.pane.getByRole('button', { name: 'Tab', exact: true });
    await expect(escape).toHaveCount(1);
    await expect(tab).toHaveCount(1);
    const textTools = t.pane.getByRole('group', { name: 'Text tools', exact: true });
    const promptTools = t.pane.getByRole('group', { name: 'Prompt tools', exact: true });
    await expect(t.pane.getByRole('group', { name: 'Common keys', exact: true }).getByRole('button')).toHaveText(['Esc', 'Tab', 'Enter', 'Copy', 'Paste']);
    await expect(textTools.getByRole('button')).toHaveText(['Text']);
    await expect(promptTools.getByRole('button')).toHaveText(['Prompts', 'History']);
    await expect(t.pane.getByRole('group', { name: 'Modifiers', exact: true, includeHidden: true })).toHaveCount(0);
    await expect(t.pane.getByRole('button', { name: /^Use (Control|Alt) with/, includeHidden: true })).toHaveCount(0);
    await expect(t.pane.getByRole('group', { name: 'Navigation', exact: true }).getByRole('button')).toHaveText(['↑', '↓', '←', '→']);
    await expect(t.pane.getByRole('group', { name: 'Key combinations', exact: true }).getByRole('button')).toHaveText(['Shift + ←', 'Ctrl-C', 'Ctrl-O', 'Ctrl-E', 'Ctrl-X Ctrl-S']);
    for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await expect(keyboard).toBeInViewport({ ratio: 1 });
      await expect(escape).toBeInViewport({ ratio: 1 });
      await expect(tab).toBeInViewport({ ratio: 1 });
      const geometry = await t.pane.evaluate(element => {
        const keyboard = element.querySelector('.terminal-keyboard')!.getBoundingClientRect();
        const keys = element.querySelector('.terminal-keys')!;
        const [escape, tab, enter, copy, paste, up, down] = ['Esc', 'Tab', 'Enter', 'Copy', 'Paste', '↑', '↓'].map(label =>
          keys.querySelector(`button[aria-label="${label}"]`)!.getBoundingClientRect());
        const tools = element.querySelector('.terminal-tools')!.getBoundingClientRect();
        return { keyboardGap: escape.left - keyboard.right, tabGap: tab.left - escape.right, enterGap: enter.left - tab.right, copyGap: copy.left - enter.right, pasteGap: paste.left - copy.right, shortcutGap: down.left - up.right, groupGap: up.left - paste.right,
          keyboardTop: keyboard.top, escapeTop: escape.top, tabTop: tab.top, shortcutTop: enter.top, copyTop: copy.top, pasteTop: paste.top,
          toolsTop: tools.top, keyboardBottom: keyboard.bottom,
          keyboardHeight: keyboard.height, escapeHeight: escape.height, escapeWidth: escape.width, tabHeight: tab.height, tabWidth: tab.width, shortcutHeight: enter.height };
      });
      expect(geometry.keyboardGap).toBeGreaterThan(geometry.shortcutGap);
      expect(geometry.tabGap).toBeCloseTo(geometry.shortcutGap, 3);
      expect(geometry.enterGap).toBeCloseTo(geometry.shortcutGap, 3);
      expect(geometry.copyGap).toBeCloseTo(geometry.shortcutGap, 3);
      expect(geometry.pasteGap).toBeCloseTo(geometry.shortcutGap, 3);
      expect(geometry.groupGap).toBeGreaterThan(geometry.shortcutGap);
      expect(geometry.toolsTop).toBeGreaterThanOrEqual(geometry.keyboardBottom);
      expect(geometry.keyboardTop).toBeCloseTo(geometry.shortcutTop, 3);
      expect(geometry.escapeTop).toBeCloseTo(geometry.shortcutTop, 3);
      expect(geometry.tabTop).toBeCloseTo(geometry.shortcutTop, 3);
      expect(geometry.copyTop).toBeCloseTo(geometry.shortcutTop, 3);
      expect(geometry.pasteTop).toBeCloseTo(geometry.shortcutTop, 3);
      expect(geometry.keyboardHeight).toBeCloseTo(geometry.shortcutHeight, 3);
      expect(geometry.escapeHeight).toBeCloseTo(geometry.shortcutHeight, 3);
      expect(geometry.tabHeight).toBeCloseTo(geometry.shortcutHeight, 3);
      expect(geometry.keyboardHeight).toBeGreaterThanOrEqual(44);
      expect(geometry.escapeHeight).toBeGreaterThanOrEqual(44);
      expect(geometry.escapeWidth).toBeGreaterThanOrEqual(44);
      expect(geometry.tabHeight).toBeGreaterThanOrEqual(44);
      expect(geometry.tabWidth).toBeGreaterThanOrEqual(44);
      const keyboardBefore = await keyboard.boundingBox();
      const escapeBefore = (await escape.boundingBox())!;
      const tabBefore = (await tab.boundingBox())!;
      const offset = await keys.evaluate(element => { element.scrollLeft = element.scrollWidth; return element.scrollLeft; });
      expect(offset).toBeGreaterThan(0);
      expect((await escape.boundingBox())!.x).toBeCloseTo(escapeBefore.x - offset, 3);
      expect((await tab.boundingBox())!.x).toBeCloseTo(tabBefore.x - offset, 3);
      expect(await keyboard.boundingBox()).toEqual(keyboardBefore);
      for (const tool of await t.pane.locator('.terminal-tools button').all()) await expect(tool).toBeInViewport({ ratio: 1 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await keys.evaluate(element => { element.scrollLeft = 0; });
      if (viewport.width === 390) await page.screenshot({ path: testInfo.outputPath(`keyboard-spacing-${viewport.width}.png`) });
    }
  });

  for (const [label, value] of [['Esc', '\u001b'], ['Tab', '\t'], ['Ctrl-O', '\u000f'], ['Ctrl-E', '\u0005']] as const) test(`${label} stays reachable without sending drafts or replaying blocked input`, async ({ page }) => {
    const t = await terminal(page), draft = await openText(t.pane);
    const shortcut = t.pane.getByRole('button', { name: label, exact: true });
    const keyboard = t.pane.locator('.terminal-keyboard');
    await draft.text.fill('unsent draft');
    await page.setViewportSize({ width: 390, height: 420 });
    await t.pane.locator('.terminal-keys').evaluate(element => { element.scrollLeft = element.scrollWidth; });
    await shortcut.scrollIntoViewIfNeeded();
    await expect(shortcut).toBeInViewport({ ratio: 1 });
    await expect(shortcut).toHaveCSS('touch-action', 'manipulation');
    await shortcut.tap();
    await expect.poll(() => t.input).toEqual([value]);
    await expect(t.textarea).toBeFocused();
    await expect(draft.text).toHaveValue('unsent draft');
    await expect(keyboard).toHaveAttribute('aria-pressed', 'true');
    await keyboard.tap();
    await expect(t.textarea).not.toBeFocused();
    await expect(keyboard).toHaveAttribute('aria-pressed', 'false');

    await shortcut.tap();
    await expect.poll(() => t.input).toEqual([value, value]);
    await page.keyboard.type('x');
    const sent = value + value + 'x';
    await expect.poll(() => t.input.join('')).toBe(sent);

    t.send(JSON.stringify({ type: 'state', mode: 'observe', cols: 80, rows: 24 }));
    await expect(t.pane).toHaveAttribute('data-mode', 'observe');
    await shortcut.tap();
    t.send(JSON.stringify({ type: 'state', mode: 'control', cols: 80, rows: 24 }));
    await expect(t.pane).toHaveAttribute('data-mode', 'control');
    await page.keyboard.type('control');
    await expect.poll(() => t.input.join('')).toBe(sent + 'control');
    t.disconnect();
    await expect(t.pane).toHaveAttribute('data-mode', 'disconnected');
    await shortcut.tap();
    await expect(t.pane).toHaveAttribute('data-mode', 'control');
    await t.textarea.focus(); await page.keyboard.type('reconnected');
    await expect.poll(() => t.input.join('')).toBe(sent + 'controlreconnected');
    await draft.toggle.tap();
    await expect(draft.text).toHaveValue('unsent draft');
  });

  test('Keyboard stays reachable and synchronously focuses raw input without sending a Text draft', async ({ page }) => {
    const t = await terminal(page), draft = await openText(t.pane);
    await draft.text.fill('unsent draft');
    await page.setViewportSize({ width: 390, height: 420 });
    const keyboard = t.pane.getByRole('button', { name: 'Toggle terminal keyboard', exact: true });
    await expect(keyboard).toBeVisible();
    const before = (await keyboard.boundingBox())!;
    await t.pane.locator('.terminal-keys').evaluate(element => { element.scrollLeft = element.scrollWidth; });
    expect(await keyboard.boundingBox()).toEqual(before);
    expect(before.width).toBeGreaterThanOrEqual(44);
    expect(before.height).toBeGreaterThanOrEqual(44);
    expect(before.x).toBeGreaterThanOrEqual(0);
    expect(before.y + before.height).toBeLessThanOrEqual(420);
    await expect(keyboard).toHaveCSS('touch-action', 'manipulation');
    // Focus must happen inside the gesture, before a promise, frame or socket response.
    expect(await keyboard.evaluate((element: HTMLButtonElement) => {
      element.click();
      return document.activeElement === element.closest('.terminal-pane')!.querySelector('.xterm-helper-textarea');
    })).toBe(true);
    await expect(draft.text).toBeHidden();
    await expect(draft.toggle).toHaveAttribute('aria-expanded', 'false');
    expect(t.input).toEqual([]);
    await keyboard.tap();
    await expect(t.textarea).not.toBeFocused();
    await keyboard.tap();
    await expect(t.textarea).toBeFocused();
    await page.keyboard.type('raw');
    await expect.poll(() => t.input.join('')).toBe('raw');
    await draft.toggle.click();
    await expect(draft.text).toHaveValue('unsent draft');
    await keyboard.tap();
    t.send(JSON.stringify({ type: 'state', mode: 'observe', cols: 80, rows: 24 }));
    await expect(t.pane).toHaveAttribute('data-mode', 'observe');
    await keyboard.tap();
    await expect(t.textarea).not.toBeFocused();
    await keyboard.tap();
    await expect(t.textarea).toBeFocused();
    await page.keyboard.type('dropped');
    t.send(JSON.stringify({ type: 'state', mode: 'control', cols: 80, rows: 24 }));
    await expect(t.pane).toHaveAttribute('data-mode', 'control');
    expect(t.input.join('')).toBe('raw');
  });

  test('a short terminal tap focuses synchronously without treating scrolling or interrupted touches as taps', async ({ page }) => {
    const t = await terminal(page);
    const result = await t.pane.locator('.terminal-host').evaluate(host => {
      const screen = host.querySelector('.xterm-screen')!, textarea = host.querySelector<HTMLTextAreaElement>('textarea')!;
      const touch = (identifier: number, x = 80, y = 80) => ({ identifier, clientX: x, clientY: y });
      const fire = (type: string, touches: ReturnType<typeof touch>[], changed = touches, time = 0) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, { touches: { value: touches }, changedTouches: { value: changed }, timeStamp: { value: time } });
        screen.dispatchEvent(event);
        return event.defaultPrevented;
      };
      return ['tap', 'small move', 'vertical', 'horizontal', 'multitouch', 'cancel', 'long press'].map(kind => {
        textarea.blur();
        fire('touchstart', [touch(1)]);
        if (kind === 'small move') fire('touchmove', [touch(1, 82, 83)]);
        if (kind === 'vertical') fire('touchmove', [touch(1, 80, 110)]);
        if (kind === 'horizontal') fire('touchmove', [touch(1, 110, 80)]);
        if (kind === 'multitouch') fire('touchstart', [touch(1), touch(2)]);
        if (kind === 'cancel') fire('touchcancel', [], [touch(1)]);
        const cancelled = fire('touchend', [], [touch(1)], kind === 'long press' ? 1000 : 100);
        return { kind, focused: document.activeElement === textarea, cancelled };
      });
    });
    expect(result).toEqual(['tap', 'small move', 'vertical', 'horizontal', 'multitouch', 'cancel', 'long press'].map(kind => ({
      kind, focused: kind === 'tap' || kind === 'small move', cancelled: false,
    })));
    expect(t.input).toEqual([]);
  });

  for (const platform of ['iPhone', 'MacIntel']) test(`native spelling on ${platform} keeps corrections local until Send text`, async ({ page }) => {
    const t = await terminal(page, platform), draft = await openText(t.pane);
    await expect(draft.text).toHaveAttribute('spellcheck', 'true');
    await expect(draft.text).toHaveAttribute('autocorrect', 'on');
    await expect(draft.text).toHaveAttribute('autocapitalize', 'off');
    await expect(draft.send).toBeDisabled();
    await page.keyboard.type('teh');
    // Exercise the browser edit contract; the OS dictionary and suggestion UI need a real iPhone.
    const cancelled = await draft.text.evaluate((element: HTMLTextAreaElement) => {
      const before = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertReplacementText', data: 'the' });
      element.dispatchEvent(before);
      if (!before.defaultPrevented) {
        element.setRangeText('the', 0, 3, 'end');
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: 'the' }));
      }
      return before.defaultPrevented;
    });
    expect(cancelled).toBe(false);
    await expect(draft.text).toHaveValue('the');
    expect(t.input).toEqual([]);
    await draft.send.click();
    await expect.poll(() => t.input.join('')).toBe('the');
    await expect(draft.text).toHaveValue('');
    await expect(draft.text).toBeFocused();
    await expect(draft.send).toBeDisabled();
    await draft.toggle.click();
    await expect(t.textarea).toBeFocused();
    await expect(t.textarea).toHaveAttribute('autocorrect', 'off');
    await page.keyboard.type('raw');
    await expect.poll(() => t.input.join('')).toBe('theraw');
  });

  test('native spelling preserves IME, whitespace and multiline paste', async ({ page }) => {
    const t = await terminal(page), draft = await openText(t.pane);
    t.send(Buffer.from('\u001b[?2004hbracketed ready\r\n'));
    await expect(t.pane.locator('.xterm-rows')).toContainText('bracketed ready');
    await draft.text.dispatchEvent('compositionstart');
    await draft.text.fill('\u304b');
    await expect(draft.send).toBeDisabled();
    expect(t.input).toEqual([]);
    await draft.text.dispatchEvent('compositionend', { data: '\u304b' });
    await expect(draft.send).toBeEnabled();
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('  caf\u00e9 \ud83d\ude42 ');
    const expected = '\u304b\n  caf\u00e9 \ud83d\ude42 ';
    await expect(draft.text).toHaveValue(expected);
    expect(t.input).toEqual([]);
    await draft.send.click();
    await expect.poll(() => t.input.join('')).toBe('\u001b[200~' + expected.replace('\n', '\r') + '\u001b[201~');
  });

  test('native spelling never sends or replays a draft during observation or disconnection', async ({ page }) => {
    const t = await terminal(page), draft = await openText(t.pane);
    await draft.text.fill('unsent draft');
    t.send(JSON.stringify({ type: 'state', mode: 'observe', cols: 80, rows: 24 }));
    await expect(t.pane).toHaveAttribute('data-mode', 'observe');
    await expect(draft.send).toBeDisabled();
    await draft.send.evaluate((element: HTMLButtonElement) => element.click());
    await expect(draft.text).toHaveValue('unsent draft');
    t.send(JSON.stringify({ type: 'state', mode: 'control', cols: 80, rows: 24 }));
    await expect(draft.send).toBeEnabled();
    expect(t.input).toEqual([]);
    t.disconnect();
    await expect(t.pane).toHaveAttribute('data-mode', 'disconnected');
    await expect(draft.send).toBeDisabled();
    await draft.send.evaluate((element: HTMLButtonElement) => element.click());
    await expect(t.pane).toHaveAttribute('data-mode', 'control');
    await expect(draft.send).toBeEnabled();
    await expect(draft.text).toHaveValue('unsent draft');
    expect(t.input).toEqual([]);
    await draft.send.click();
    await expect.poll(() => t.input.join('')).toBe('unsent draft');
  });

  test('native spelling keeps per-project drafts only for the mounted page', async ({ page }) => {
    const t = await terminal(page), draft = await openText(t.pane);
    await draft.text.fill('alpha draft');
    await draft.toggle.click();
    await draft.toggle.click();
    await expect(draft.text).toHaveValue('alpha draft');
    await page.getByRole('button', { name: 'Open project drawer', exact: true }).click();
    await page.locator('.project-item').filter({ hasText: 'beta' }).click();
    const beta = page.locator('.terminal-pane:not([hidden])');
    await expect(beta).toHaveAttribute('data-mode', 'control');
    const other = await openText(beta);
    await expect(other.text).toHaveValue('');
    await other.text.fill('beta draft');
    await page.getByRole('button', { name: 'Open project drawer', exact: true }).click();
    await page.locator('.project-item').filter({ hasText: 'alpha' }).click();
    await expect(page.getByRole('textbox', { name: 'Terminal text', exact: true })).toHaveValue('alpha draft');
    expect(t.input).toEqual([]);
    await page.reload();
    const current = page.locator('.terminal-pane:not([hidden])');
    await expect(current).toHaveAttribute('data-mode', 'control');
    await expect((await openText(current)).text).toHaveValue('');
    expect(t.input).toEqual([]);
  });

  test('native spelling fits a keyboard-reduced phone viewport in both themes', async ({ page }, testInfo) => {
    const t = await terminal(page), draft = await openText(t.pane);
    await page.setViewportSize({ width: 390, height: 420 });
    await draft.text.fill('Check this text before sending.');
    for (const theme of ['light', 'dark']) {
      if (await page.locator('html').getAttribute('data-theme') !== theme) {
        await page.getByRole('button', { name: /theme/i }).click();
      }
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await draft.text.focus();
      for (const locator of [draft.text, draft.send, draft.toggle]) {
        const bounds = await locator.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.y).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(420);
      }
      expect(await draft.text.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
      await page.screenshot({ path: testInfo.outputPath(`native-spelling-${theme}.png`) });
    }
    expect(t.input).toEqual([]);
  });

  test('iOS leaves Backspace uncancelled and forwards every native repeat exactly once', async ({ page }) => {
    const t = await terminal(page);
    const cancelled = await t.textarea.evaluate(element => {
      const event = new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', keyCode: 8, bubbles: true, cancelable: true });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(cancelled).toBe(false);
    expect(await deleteInput(t.textarea, 12)).toEqual(Array.from({ length: 12 }, () => ({ cancelled: false, editable: true })));
    await t.textarea.dispatchEvent('keyup', { key: 'Backspace', code: 'Backspace', keyCode: 8 });
    await expect.poll(() => t.input.join('')).toBe('\u007f'.repeat(12));
    // A released key must not leave a timer generating terminal input.
    await page.waitForTimeout(200);
    expect(t.input.join('')).toBe('\u007f'.repeat(12));
  });

  test('iPad desktop identity supports input-only deletion and longer backward edits', async ({ page }) => {
    const t = await terminal(page, 'MacIntel');
    for (const type of ['deleteContentBackward', 'deleteWordBackward', 'deleteSoftLineBackward', 'deleteHardLineBackward']) {
      expect(await deleteInput(t.textarea, 2, type)).toEqual([{ cancelled: false, editable: true }, { cancelled: false, editable: true }]);
    }
    await expect.poll(() => t.input.join('')).toBe('\u007f'.repeat(8));
  });

  test('iOS keeps typing, hardware repeat, modifiers and paste independent of helper text', async ({ page }) => {
    const t = await terminal(page);
    await page.keyboard.type('abc');
    await page.keyboard.down('Backspace');
    await page.keyboard.down('Backspace');
    await page.keyboard.up('Backspace');
    await expect.poll(() => t.input.join('')).toBe('abc\u007f\u007f');
    await page.keyboard.press('Control+Backspace');
    await page.keyboard.press('Alt+Backspace');
    await page.keyboard.press('Enter');
    expect(await deleteInput(t.textarea)).toEqual([{ cancelled: false, editable: true }]);
    await expect.poll(() => t.input.join('')).toBe('abc\u007f\u007f\b\u001b\u007f\r\u007f');
    t.send(Buffer.from('\u001b[?2004hbracketed ready\r\n'));
    await expect(t.pane.locator('.xterm-rows')).toContainText('bracketed ready');
    await t.pane.getByRole('button', { name: 'Paste', exact: true }).click();
    await expect.poll(() => t.input.join('')).toContain('\u001b[200~paste\rtext\u001b[201~');
    expect(await deleteInput(t.textarea, 2)).toEqual([{ cancelled: false, editable: true }, { cancelled: false, editable: true }]);
    await expect.poll(() => t.input.join('')).toBe('abc\u007f\u007f\b\u001b\u007f\r\u007f\u001b[200~paste\rtext\u001b[201~\u007f\u007f');
    await page.keyboard.press('Alt+Backspace');
    await deleteInput(t.textarea);
    await expect.poll(() => t.input.slice(-2)).toEqual(['\u001b\u007f', '\u007f']);
  });

  test('iOS leaves composition and cancellation to the IME without leaking helper text', async ({ page }) => {
    const t = await terminal(page);
    await t.textarea.evaluate(async (element: HTMLTextAreaElement) => {
      const prefix = element.value;
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      element.value = prefix + '\u304b\u306a';
      element.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: '\u304b\u306a' }));
      element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Backspace', keyCode: 229, isComposing: true }));
      element.value = prefix + '\u304b';
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', isComposing: true }));
      await new Promise(resolve => setTimeout(resolve, 0));
      element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '\u304b' }));
    });
    await expect.poll(() => t.input.join('')).toBe('\u304b');
    await t.textarea.evaluate(async (element: HTMLTextAreaElement) => {
      element.value = '';
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      element.value = '\u306a';
      element.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: '\u306a' }));
      await new Promise(resolve => setTimeout(resolve, 0));
      element.value = '';
      element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(t.input.join('')).toBe('\u304b');
    expect(await deleteInput(t.textarea)).toEqual([{ cancelled: false, editable: true }]);
    await expect.poll(() => t.input.join('')).toBe('\u304b\u007f');
  });

  test('iOS drops observer and disconnected deletes and does not replay them after reconnect', async ({ page }) => {
    const t = await terminal(page);
    t.send(JSON.stringify({ type: 'state', mode: 'observe', cols: 80, rows: 24 }));
    await expect(t.pane).toHaveAttribute('data-mode', 'observe');
    expect(await deleteInput(t.textarea, 3)).toHaveLength(3);
    t.send(JSON.stringify({ type: 'state', mode: 'control', cols: 80, rows: 24 }));
    await expect(t.pane).toHaveAttribute('data-mode', 'control');
    expect(t.input).toEqual([]);
    await deleteInput(t.textarea);
    await expect.poll(() => t.input.join('')).toBe('\u007f');
    t.disconnect();
    await expect(t.pane).toHaveAttribute('data-mode', 'disconnected');
    await deleteInput(t.textarea, 3);
    await expect(t.pane).toHaveAttribute('data-mode', 'control');
    expect(t.input.join('')).toBe('\u007f');
    await t.textarea.focus();
    await deleteInput(t.textarea);
    await expect.poll(() => t.input.join('')).toBe('\u007f\u007f');
    await page.getByRole('button', { name: 'Machine settings', exact: true }).click();
    await expect(t.textarea).not.toBeFocused();
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await t.textarea.focus();
    expect(await deleteInput(t.textarea, 2)).toHaveLength(2);
    await expect.poll(() => t.input.join('')).toBe('\u007f'.repeat(4));
  });

  test('non-iOS keyboards retain xterm keydown handling without seeded text or duplicate deletion', async ({ page }) => {
    const t = await terminal(page, 'Linux x86_64');
    await expect(t.pane.getByRole('button', { name: 'Text', exact: true })).toHaveCount(0);
    await expect(t.textarea).toHaveValue('');
    await page.keyboard.type('abc');
    await page.keyboard.down('Backspace');
    await page.keyboard.down('Backspace');
    await page.keyboard.up('Backspace');
    await page.keyboard.press('Control+Backspace');
    await expect.poll(() => t.input.join('')).toBe('abc\u007f\u007f\b');
    await t.textarea.dispatchEvent('input', { inputType: 'deleteContentBackward' });
    expect(t.input.join('')).toBe('abc\u007f\u007f\b');
  });
});
