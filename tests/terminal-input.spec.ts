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
  const textarea = pane.locator('textarea');
  await textarea.focus();
  return { input, send, disconnect, pane, textarea };
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
