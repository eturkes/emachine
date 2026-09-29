import { test, expect, type Page } from '@playwright/test';
// @ts-expect-error This JavaScript fixture drives the real native server.
import { fixture } from './network-helper.mjs';

let machine: any;
test.beforeAll(async () => { machine = await fixture(); });
test.afterAll(async () => { await machine?.close(); });

async function terminal(page: Page) {
  const input: string[] = [];
  let send!: (data: string | Buffer) => void;
  await page.addInitScript(() => {
    // ChromiumFish advertises Windows; use the Linux clipboard line endings under test.
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Linux x86_64' });
    const clipboard = { text: 'preserve this', writes: [] as string[], reads: 0, denied: false };
    (window as any).clipboardFixture = clipboard;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => {
        if (clipboard.denied) throw new DOMException('Denied', 'NotAllowedError');
        clipboard.writes.push(text); clipboard.text = text;
      },
      readText: async () => {
        clipboard.reads++;
        if (clipboard.denied) throw new DOMException('Denied', 'NotAllowedError');
        return clipboard.text;
      },
    } });
  });
  await page.routeWebSocket(/\/api\/v1\/terminal\//, ws => {
    send = data => ws.send(data);
    ws.onMessage(data => { if (Buffer.isBuffer(data)) input.push(data.toString()); });
    send(JSON.stringify({ type: 'state', mode: 'control', session: 'clipboard', cols: 80, rows: 24 }));
    send(Buffer.from('\u001b[2J\u001b[HclipboardFixture\r\nsecond line\r\n'));
  });
  await page.goto(machine.origin);
  const pane = page.locator('.terminal-pane:not([hidden])');
  await expect(pane).toHaveAttribute('data-mode', 'control');
  await expect(pane.locator('.xterm-rows')).toContainText('clipboardFixture');
  const host = pane.locator('.terminal-host'), textarea = pane.locator('.xterm-helper-textarea');
  const menu = page.getByRole('menu', { name: 'Terminal actions', exact: true });
  const select = async () => {
    const bounds = (await pane.locator('.xterm-rows span').filter({ hasText: /^clipboardFixture$/ }).first().boundingBox())!;
    await page.mouse.dblclick(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  };
  const open = async () => {
    await host.click({ button: 'right', position: { x: 240, y: 70 } });
    await expect(menu).toBeVisible();
  };
  return { input, send, pane, host, textarea, menu, select, open };
}
const clipboard = (page: Page) => page.evaluate(() => (window as any).clipboardFixture);

test('terminal clipboard shortcut copies once without sending input and leaves plain Ctrl+C intact', async ({ page }) => {
  const t = await terminal(page);
  await t.select();
  await page.keyboard.press('Control+Shift+C');
  await expect.poll(async () => (await clipboard(page)).writes).toEqual(['clipboardFixture']);
  expect(t.input).toEqual([]);
  await expect(t.textarea).toBeFocused();
  // Autorepeat must not turn a held copy shortcut into repeated clipboard writes.
  await t.textarea.dispatchEvent('keydown', { key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true, repeat: true });
  expect((await clipboard(page)).writes).toEqual(['clipboardFixture']);
  await page.keyboard.press('Control+c');
  await expect.poll(() => t.input.join('')).toBe('\u0003');
  await t.host.click({ position: { x: 240, y: 70 } });
  await page.keyboard.press('Control+Shift+C');
  await expect(page.locator('.toast-region')).toContainText('Select terminal text to copy.');
  expect((await clipboard(page)).writes).toEqual(['clipboardFixture']);
  expect(t.input).toEqual(['\u0003']);
  // A shortcut outside the terminal must not copy a hidden terminal's selection.
  await page.getByRole('button', { name: 'Machine settings', exact: true }).focus();
  await page.keyboard.press('Control+Shift+C');
  expect((await clipboard(page)).writes).toEqual(['clipboardFixture']);
});

test('terminal clipboard shortcut pastes once with bracketed-paste encoding and resets one-shot modifiers', async ({ page }) => {
  const t = await terminal(page);
  t.send(Buffer.from('\u001b[?2004hbracketed ready\r\n'));
  await expect(t.pane.locator('.xterm-rows')).toContainText('bracketed ready');
  await page.evaluate(() => { (window as any).clipboardFixture.text = 'a\nb'; });
  const ctrl = t.pane.getByRole('button', { name: 'Use Control with the next character', exact: true });
  const alt = t.pane.getByRole('button', { name: 'Use Alt with the next key', exact: true });
  await ctrl.click(); await alt.click();
  await page.keyboard.press('Control+Shift+V');
  await expect.poll(() => t.input.join('')).toBe('\u001b[200~a\rb\u001b[201~');
  expect((await clipboard(page)).reads).toBe(1);
  await expect(ctrl).toHaveAttribute('aria-pressed', 'false');
  await expect(alt).toHaveAttribute('aria-pressed', 'false');
  await expect(t.textarea).toBeFocused();
});

test('terminal context menu preserves selection and shares Copy, Paste, Select all and Clear selection actions', async ({ page }) => {
  const t = await terminal(page);
  await t.select(); await t.open();
  const copy = t.menu.getByRole('menuitem', { name: 'Copy', exact: true });
  await expect(copy).toBeEnabled();
  await expect(copy).toHaveAttribute('aria-keyshortcuts', 'Control+Shift+C');
  await copy.click();
  await expect.poll(async () => (await clipboard(page)).writes).toEqual(['clipboardFixture']);
  await expect(t.menu).toBeHidden();
  await expect(t.textarea).toBeFocused();
  expect(t.input).toEqual([]);
  await t.open(); await t.menu.getByRole('menuitem', { name: 'Select all', exact: true }).click();
  await t.open(); await copy.click();
  expect((await clipboard(page)).text).toContain('clipboardFixture\nsecond line');
  await t.open(); await t.menu.getByRole('menuitem', { name: 'Clear selection', exact: true }).click();
  await t.open();
  await expect(copy).toBeDisabled();
  await expect(t.menu.getByRole('menuitem', { name: 'Clear selection', exact: true })).toBeDisabled();
  await page.evaluate(() => { (window as any).clipboardFixture.text = 'menu paste'; });
  await t.menu.getByRole('menuitem', { name: 'Paste', exact: true }).click();
  await expect.poll(() => t.input.join('')).toBe('menu paste');
  expect((await clipboard(page)).reads).toBe(1);
  await expect(t.menu).toBeHidden();
  await expect(t.textarea).toBeFocused();
});

test('terminal context menu supports keyboard navigation, edge placement, dismissal and project changes', async ({ page }) => {
  const t = await terminal(page);
  await t.textarea.focus(); await page.keyboard.press('Shift+F10');
  await expect(t.menu).toBeVisible();
  await expect(t.menu.getByRole('menuitem', { name: 'Paste', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(t.menu.getByRole('menuitem', { name: 'Select all', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(t.menu.getByRole('menuitem', { name: 'Paste', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(t.menu.getByRole('menuitem', { name: 'Select all', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(t.menu).toBeHidden(); await expect(t.textarea).toBeFocused();
  await page.keyboard.press('ContextMenu');
  await expect(t.menu.getByRole('menuitem', { name: 'Copy', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(t.menu.getByRole('menuitem', { name: 'Clear selection', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(t.menu).toBeHidden(); await expect(t.textarea).toBeFocused();
  expect(t.input).toEqual([]);
  for (const theme of ['dark', 'light']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await t.select();
    const bounds = (await t.host.boundingBox())!;
    await t.host.click({ button: 'right', position: { x: bounds.width - 5, y: bounds.height - 5 } });
    await expect(t.menu).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: `test-results/emachine-terminal-menu-${theme}.png` });
    await page.keyboard.press('Escape');
  }
  await t.open();
  await page.keyboard.press('Tab');
  await expect(t.menu).toBeHidden();
  await t.open();
  await page.getByRole('button', { name: 'Machine settings', exact: true }).click();
  await expect(t.menu).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Machines', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await t.open();
  await page.getByRole('button', { name: 'beta on Test workstation, online', exact: true }).click();
  await expect(t.menu).toBeHidden();
  await page.getByRole('button', { name: 'alpha on Test workstation, online', exact: true }).click();
  await expect(t.menu).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  await t.open();
  await expect(t.menu).toBeInViewport({ ratio: 1 });
  await page.setViewportSize({ width: 400, height: 844 });
  await expect(t.menu).toBeHidden();
});

test('terminal context menu does not forward right-clicks to mouse-reporting applications', async ({ page }) => {
  const t = await terminal(page);
  t.send(Buffer.from('\u001b[?1000h\u001b[?1006hmouse ready\r\n'));
  await expect(t.pane.locator('.xterm-rows')).toContainText('mouse ready');
  await t.open();
  await page.keyboard.press('Escape');
  expect(t.input).toEqual([]);
  // Other mouse buttons still reach applications that requested mouse reporting.
  await t.host.click({ position: { x: 100, y: 50 } });
  await expect.poll(() => t.input.join('')).toMatch(/\u001b\[<0;\d+;\d+M\u001b\[<0;\d+;\d+m/);
});

test('terminal clipboard actions report permission failures and prevent observer paste', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const t = await terminal(page);
  await t.select();
  await page.evaluate(() => { (window as any).clipboardFixture.denied = true; });
  await page.keyboard.press('Control+Shift+C');
  await expect(page.locator('.toast-region')).toContainText('Clipboard access was not granted.');
  await t.open(); await t.menu.getByRole('menuitem', { name: 'Paste', exact: true }).click();
  expect(t.input).toEqual([]);
  await page.evaluate(() => { (window as any).clipboardFixture.denied = false; });
  t.send(JSON.stringify({ type: 'state', mode: 'observe', session: 'clipboard', cols: 80, rows: 24 }));
  await expect(t.pane).toHaveAttribute('data-mode', 'observe');
  await t.select(); await t.open();
  await expect(t.menu.getByRole('menuitem', { name: 'Paste', exact: true })).toBeDisabled();
  await t.menu.getByRole('menuitem', { name: 'Copy', exact: true }).click();
  expect((await clipboard(page)).text).toBe('clipboardFixture');
  await page.keyboard.press('Control+Shift+V');
  await expect(page.locator('.toast-region')).toContainText('Reconnect and take control before pasting.');
  expect(t.input).toEqual([]);
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
  await page.keyboard.press('Control+Shift+C');
  await page.keyboard.press('Control+Shift+V');
  expect(errors).toEqual([]);
});
