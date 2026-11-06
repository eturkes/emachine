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
