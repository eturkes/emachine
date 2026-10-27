import { test, expect, type Locator, type Page } from '@playwright/test';
// @ts-expect-error This JavaScript fixture drives the real native server.
import { fixture } from './network-helper.mjs';

let machine: any;
test.beforeAll(async () => { machine = await fixture(); });
test.afterAll(async () => { await machine?.close(); });

async function terminal(page: Page, platform = 'iPhone') {
  const input: string[] = [];
  let send!: (data: string | Buffer) => void;
  let disconnect!: () => void;
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

  test('Keyboard, Esc and Tab spacing matches adjacent shortcuts across phone and tablet widths', async ({ page }, testInfo) => {
    const t = await terminal(page);
    const escape = t.pane.getByRole('button', { name: 'Esc', exact: true });
    const tab = t.pane.getByRole('button', { name: 'Tab', exact: true });
    await expect(escape).toHaveCount(1);
    await expect(tab).toHaveCount(1);
    for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1024, height: 768 }]) {
      await page.setViewportSize(viewport);
      await expect(t.pane.locator('.terminal-keyboard')).toBeInViewport({ ratio: 1 });
      await expect(escape).toBeInViewport({ ratio: 1 });
      await expect(tab).toBeInViewport({ ratio: 1 });
      const geometry = await t.pane.evaluate(element => {
        const keys = element.querySelector<HTMLElement>('.terminal-keys')!; keys.scrollLeft = 0;
        const keyboard = element.querySelector('.terminal-keyboard')!.getBoundingClientRect();
        const escape = element.querySelector('button[aria-label="Esc"]')!.getBoundingClientRect();
        const tab = element.querySelector('button[aria-label="Tab"]')!.getBoundingClientRect();
        const [first, second] = Array.from(keys.querySelectorAll('button')).filter(button => button.getClientRects().length).map(button => button.getBoundingClientRect());
        return { fixedGap: escape.left - keyboard.right, tabGap: tab.left - escape.right, scrollGap: first.left - tab.right, shortcutGap: second.left - first.right,
          keyboardTop: keyboard.top, escapeTop: escape.top, tabTop: tab.top, shortcutTop: first.top,
          keyboardHeight: keyboard.height, escapeHeight: escape.height, escapeWidth: escape.width, tabHeight: tab.height, tabWidth: tab.width, shortcutHeight: first.height };
      });
      expect(geometry.fixedGap).toBeCloseTo(geometry.shortcutGap, 3);
      expect(geometry.tabGap).toBeCloseTo(geometry.shortcutGap, 3);
      expect(geometry.scrollGap).toBeCloseTo(geometry.shortcutGap, 3);
      expect(geometry.keyboardTop).toBeCloseTo(geometry.shortcutTop, 3);
      expect(geometry.escapeTop).toBeCloseTo(geometry.shortcutTop, 3);
      expect(geometry.tabTop).toBeCloseTo(geometry.shortcutTop, 3);
      expect(geometry.keyboardHeight).toBeCloseTo(geometry.shortcutHeight, 3);
      expect(geometry.escapeHeight).toBeCloseTo(geometry.shortcutHeight, 3);
      expect(geometry.tabHeight).toBeCloseTo(geometry.shortcutHeight, 3);
      expect(geometry.keyboardHeight).toBeGreaterThanOrEqual(44);
      expect(geometry.escapeHeight).toBeGreaterThanOrEqual(44);
      expect(geometry.escapeWidth).toBeGreaterThanOrEqual(44);
      expect(geometry.tabHeight).toBeGreaterThanOrEqual(44);
      expect(geometry.tabWidth).toBeGreaterThanOrEqual(44);
      const before = await escape.boundingBox();
      const tabBefore = await tab.boundingBox();
      await t.pane.locator('.terminal-keys').evaluate(element => { element.scrollLeft = element.scrollWidth; });
      expect(await escape.boundingBox()).toEqual(before);
      expect(await tab.boundingBox()).toEqual(tabBefore);
      await expect(escape).toBeInViewport({ ratio: 1 });
      await expect(tab).toBeInViewport({ ratio: 1 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await t.pane.locator('.terminal-keys').evaluate(element => { element.scrollLeft = 0; });
      if (viewport.width === 390 || viewport.width === 844) await page.screenshot({ path: testInfo.outputPath(`keyboard-spacing-${viewport.width}.png`) });
    }
  });

  for (const [label, value] of [['Esc', '\u001b'], ['Tab', '\t']] as const) test(`${label} stays reachable without sending drafts or replaying blocked input`, async ({ page }) => {
    const t = await terminal(page), draft = await openText(t.pane);
    const shortcut = t.pane.getByRole('button', { name: label, exact: true });
    const keyboard = t.pane.locator('.terminal-keyboard');
    await draft.text.fill('unsent draft');
    await page.setViewportSize({ width: 390, height: 420 });
    await t.pane.locator('.terminal-keys').evaluate(element => { element.scrollLeft = element.scrollWidth; });
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

    const ctrl = t.pane.getByRole('button', { name: 'Use Control with the next character', exact: true });
    const alt = t.pane.getByRole('button', { name: 'Use Alt with the next key', exact: true });
    await ctrl.tap(); await alt.tap(); await shortcut.tap();
    await expect.poll(() => t.input).toEqual([value, '\u001b' + value]);
    await expect(ctrl).toHaveAttribute('aria-pressed', 'false');
    await expect(alt).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.type('x');
    const sent = value + '\u001b' + value + 'x';
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

  test('native spelling preserves IME, whitespace and multiline paste without terminal modifiers', async ({ page }) => {
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
    await t.pane.getByRole('button', { name: 'Use Control with the next character', exact: true }).click();
    await t.pane.getByRole('button', { name: 'Use Alt with the next key', exact: true }).click();
    await draft.send.click();
    await expect.poll(() => t.input.join('')).toBe('\u001b[200~' + expected.replace('\n', '\r') + '\u001b[201~');
    for (const name of ['Use Control with the next character', 'Use Alt with the next key']) {
      await expect(t.pane.getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'false');
    }
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
    const alt = t.pane.getByRole('button', { name: 'Use Alt with the next key', exact: true });
    await alt.click();
    await deleteInput(t.textarea, 2);
    await expect.poll(() => t.input.slice(-2)).toEqual(['\u001b\u007f', '\u007f']);
    await expect(alt).toHaveAttribute('aria-pressed', 'false');
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
