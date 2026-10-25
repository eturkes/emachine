import { test, expect } from '@playwright/test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
// @ts-expect-error The fixture drives the native server.
import { fixture } from './network-helper.mjs';

// Service-worker fetches bypass Playwright's catalog routes in WebKit.
test.use({ serviceWorkers: 'block' });

let machine: any;
test.beforeAll(async () => { machine = await fixture(); });
test.afterAll(async () => { await machine?.close(); });

test('the terminal opens the prompt selector', async ({ page }) => {
  await page.route('**/api/v1/prompts', route => route.fulfill({ json: { prompts: [] } }));
  await page.routeWebSocket(/\/api\/v1\/terminal\//, ws => {
    ws.send(JSON.stringify({ type: 'state', mode: 'control', session: 'prompt-fixture', cols: 80, rows: 24 }));
    ws.send(Buffer.from('prompt ready\r\n'));
  });
  await page.goto(machine.origin);
  const pane = page.locator('.terminal-pane:not([hidden])');
  await expect(pane).toHaveAttribute('data-mode', 'control');
  const toggle = pane.getByRole('button', { name: 'Prompts', exact: true });
  await expect(toggle).toHaveCount(1);
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Prompts', exact: true })).toBeVisible();
});

const automatic = { id: 'claude/prompts/auto/implement.md', title: 'Implement (automatic)', body: '# Implement\r\nKeep <request> as literal prose here.\r\n\r\n', steered: false };
const steered = { id: 'claude/prompts/steered/implement.md', title: 'Implement (steered)', body: '# Implement\r\nApply the request above.\r\n', steered: true };
const another = { id: 'claude/prompts/steered/maintain.md', title: 'Maintain (steered)', body: '# Maintain\nInspect the existing system.\n', steered: true };
const catalog = [automatic, steered, another];

async function promptTerminal(page: import('@playwright/test').Page) {
  const input: string[] = [];
  let send!: (data: string | Buffer) => void;
  let disconnect!: () => void;
  let reconnectMode = 'control';
  await page.addInitScript(() => {
    (window as any).promptCopies = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => { (window as any).promptCopies.push(text); },
      readText: async () => '',
    } });
  });
  await page.routeWebSocket(/\/api\/v1\/terminal\//, ws => {
    send = data => ws.send(data);
    disconnect = () => { reconnectMode = 'observe'; ws.close(); };
    ws.onMessage(data => { if (Buffer.isBuffer(data)) input.push(data.toString()); });
    send(JSON.stringify({ type: 'state', mode: reconnectMode, session: 'prompt-fixture', cols: 80, rows: 24 }));
    send(Buffer.from('prompt ready\r\n'));
  });
  await page.goto(machine.origin);
  const pane = page.locator('.terminal-pane:not([hidden])');
  await expect(pane).toHaveAttribute('data-mode', 'control');
  await expect(pane.locator('.xterm-rows')).toContainText('prompt ready');
  return { input, pane, send: (data: string | Buffer) => send(data), disconnect: () => disconnect() };
}

async function openPrompts(page: import('@playwright/test').Page) {
  await page.locator('.terminal-pane:not([hidden])').getByRole('button', { name: 'Prompts', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Prompts', exact: true });
  await expect(dialog).toBeVisible();
  const select = dialog.getByRole('combobox', { name: 'Prompt', exact: true });
  await expect(select).toBeEnabled();
  return {
    dialog, select,
    steering: dialog.getByRole('textbox', { name: 'Steering', exact: true }),
    preview: dialog.getByRole('textbox', { name: 'Prompt preview', exact: true }),
    copy: dialog.getByRole('button', { name: 'Copy prompt', exact: true }),
    paste: dialog.getByRole('button', { name: 'Paste into terminal', exact: true }),
    reload: dialog.getByRole('button', { name: 'Reload prompts', exact: true }),
    close: dialog.getByRole('button', { name: 'Close prompts', exact: true }),
  };
}

async function routeCatalog(page: import('@playwright/test').Page) {
  await page.route('**/api/v1/prompts', route => route.fulfill({ json: { prompts: catalog } }));
}

test('real multi-section files provide separate prompt choices and steering drafts', async ({ page }) => {
  const root = join(machine.home, '.local/app/agents/claude/prompts');
  const automaticPath = join(root, 'auto/maintain.md');
  const steeredPath = join(root, 'steered/maintain.md');
  const queue = 'Work all queued rows.\n\n  Preserve indentation.';
  const security = 'Review only the security changes.';
  const requestBody = 'Complete the request above.';
  const rowsBody = 'Work only the row names above.';
  const section = (title: string, body: string) => `## ${title}\n\n---\n\n${body}\n\n---\n\n`;
  const header = '# Maintain\n\nUse: paste one body between its rules.\n\n';
  try {
    await mkdir(join(root, 'auto'), { recursive: true });
    await mkdir(join(root, 'steered'), { recursive: true });
    await writeFile(automaticPath, header + section('Queue', queue) + section('Security review', security));
    await writeFile(steeredPath, header + section('Request', '<request>\n\n' + requestBody) + section('Queue', '<rows>\n\n' + rowsBody));
    const t = await promptTerminal(page);
    t.send(Buffer.from('\u001b[?2004hsection prompts ready\r\n'));
    await expect(t.pane.locator('.xterm-rows')).toContainText('section prompts ready');
    const p = await openPrompts(page);
    await expect(p.select.locator('option')).toHaveText([
      'Maintain: Queue (automatic)', 'Maintain: Security review (automatic)',
      'Maintain: Request (steered)', 'Maintain: Queue (steered)',
    ]);
    const ids = await p.select.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
    expect(new Set(ids).size).toBe(4);
    for (const [label, expected] of [['Maintain: Queue (automatic)', queue], ['Maintain: Security review (automatic)', security]]) {
      await p.select.selectOption({ label });
      await expect(p.steering).toBeHidden();
      await expect(p.preview).toHaveValue(expected);
      await p.copy.click();
    }
    const request = 'Fix the requested behavior.';
    const rows = 'parser-boundaries\nselector-labels';
    const requestPreview = request + '\n\n' + requestBody;
    const rowsPreview = rows + '\n\n' + rowsBody;
    await p.select.selectOption({ label: 'Maintain: Request (steered)' });
    await expect(p.copy).toBeDisabled(); await expect(p.paste).toBeDisabled();
    await p.steering.fill(request);
    await expect(p.preview).toHaveValue(requestPreview); await p.copy.click();
    await p.select.selectOption({ label: 'Maintain: Queue (steered)' });
    await expect(p.steering).toHaveValue('');
    await expect(p.copy).toBeDisabled(); await expect(p.paste).toBeDisabled();
    await p.steering.fill(rows);
    await expect(p.preview).toHaveValue(rowsPreview); await p.copy.click();
    await expect.poll(() => page.evaluate(() => (window as any).promptCopies)).toEqual([queue, security, requestPreview, rowsPreview]);
    await p.select.selectOption({ label: 'Maintain: Request (steered)' });
    await expect(p.steering).toHaveValue(request);
    await expect(p.preview).toHaveValue(requestPreview);
    await p.select.selectOption({ label: 'Maintain: Queue (steered)' });
    await expect(p.steering).toHaveValue(rows);
    await p.reload.click();
    await expect(p.paste).toBeEnabled();
    await expect(p.preview).toHaveValue(rowsPreview);
    expect(t.input).toEqual([]);
    await p.paste.click();
    await expect.poll(() => t.input.join('')).toBe('\u001b[200~' + rowsPreview.replaceAll('\n', '\r') + '\u001b[201~');
    await expect(p.dialog).not.toBeVisible();
  } finally {
    await rm(automaticPath, { force: true });
    await rm(steeredPath, { force: true });
  }
});

test('duplicate section drafts follow their bodies and discarded identities stay cleared', async ({ page }) => {
  const root = join(machine.home, '.local/app/agents/claude/prompts/steered');
  const path = join(root, 'duplicate-drafts.md');
  const bodyA = 'Complete task A only.';
  const bodyB = 'Complete task B only.';
  const draftA = 'Request for task A.';
  const draftB = 'Request for task B.';
  const section = (body: string) => `## Task\n\n---\n\n<request>\n\n${body}\n\n---\n\n`;
  const source = (...bodies: string[]) => '# Duplicate drafts\n\nUse: paste one body.\n\n' + bodies.map(section).join('');
  try {
    await mkdir(root, { recursive: true });
    await writeFile(path, source(bodyA, bodyB));
    const t = await promptTerminal(page), p = await openPrompts(page);
    await expect(p.select.locator('option')).toHaveCount(2);
    const ids = await p.select.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
    expect(ids[0]).not.toBe(ids[1]);
    await p.select.selectOption(ids[0]); await p.steering.fill(draftA);
    await expect(p.preview).toHaveValue(draftA + '\n\n' + bodyA);
    await p.select.selectOption(ids[1]); await p.steering.fill(draftB);
    await expect(p.preview).toHaveValue(draftB + '\n\n' + bodyB);
    await p.select.selectOption(ids[0]);
    await writeFile(path, source(bodyB, bodyA));
    await p.reload.click(); await expect(p.reload).toBeEnabled();
    await expect(p.select).toHaveValue(ids[0]);
    await expect(p.steering).toHaveValue(draftA);
    await expect(p.preview).toHaveValue(draftA + '\n\n' + bodyA);
    await p.select.selectOption(ids[1]);
    await expect(p.steering).toHaveValue(draftB);
    await expect(p.preview).toHaveValue(draftB + '\n\n' + bodyB);

    await writeFile(path, source(bodyA));
    await page.reload();
    await expect(page.locator('.terminal-pane:not([hidden])')).toHaveAttribute('data-mode', 'control');
    const fresh = await openPrompts(page);
    await expect(fresh.select.locator('option')).toHaveCount(1);
    await fresh.steering.fill('Obsolete request for the unique task A.');
    await writeFile(path, source(bodyA, bodyB));
    await fresh.reload.click(); await expect(fresh.reload).toBeEnabled();
    await expect(fresh.select.locator('option')).toHaveCount(2);
    await writeFile(path, source(bodyB));
    await fresh.reload.click(); await expect(fresh.reload).toBeEnabled();
    await expect(fresh.select.locator('option')).toHaveCount(1);
    await expect(fresh.steering).toHaveValue('');
    await expect(fresh.preview).toHaveValue(bodyB);
    await expect(fresh.copy).toBeDisabled(); await expect(fresh.paste).toBeDisabled();
    expect(t.input).toEqual([]);
  } finally {
    await rm(path, { force: true });
  }
});

test('prompt composition, copy and paste preserve the preview without a final Enter', async ({ page }) => {
  await routeCatalog(page);
  const t = await promptTerminal(page);
  t.send(Buffer.from('\u001b[?2004hbracketed ready\r\n'));
  await expect(t.pane.locator('.xterm-rows')).toContainText('bracketed ready');
  for (const name of ['Use Control with the next character', 'Use Alt with the next key']) {
    await t.pane.getByRole('button', { name, exact: true }).click();
  }
  const p = await openPrompts(page);
  await p.select.selectOption(steered.id);
  await expect(p.copy).toBeDisabled(); await expect(p.paste).toBeDisabled();
  await p.steering.fill('  \n '); await expect(p.paste).toBeDisabled();
  const request = '  Fix the parser.\nKeep names and spacing.  ';
  await p.steering.fill(request);
  const expected = request + '\n\n# Implement\nApply the request above.';
  await expect(p.preview).toHaveValue(expected);
  await expect(p.preview).toHaveJSProperty('readOnly', true);
  expect(t.input).toEqual([]);
  await p.copy.click();
  await expect.poll(() => page.evaluate(() => (window as any).promptCopies)).toEqual([expected]);
  expect(t.input).toEqual([]);
  await p.select.selectOption(automatic.id);
  await expect(p.steering).toBeHidden();
  await expect(p.preview).toHaveValue('# Implement\nKeep <request> as literal prose here.');
  await p.select.selectOption(steered.id); await expect(p.steering).toHaveValue(request);
  await p.paste.click();
  await expect.poll(() => t.input.join('')).toBe('\u001b[200~' + expected.replaceAll('\n', '\r') + '\u001b[201~');
  await expect(p.dialog).not.toBeVisible();
  await expect(t.pane.locator('.xterm-helper-textarea')).toBeFocused();
  for (const name of ['Use Control with the next character', 'Use Alt with the next key']) {
    await expect(t.pane.getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'false');
  }
});

test('steering stays local through composition, observation and disconnection', async ({ page }) => {
  await routeCatalog(page);
  const t = await promptTerminal(page), p = await openPrompts(page);
  await p.select.selectOption(steered.id); await p.steering.fill('Preserve this draft.');
  await p.steering.dispatchEvent('compositionstart');
  await expect(p.paste).toBeDisabled(); await expect(p.copy).toBeDisabled();
  await p.paste.evaluate((element: HTMLButtonElement) => element.click());
  expect(t.input).toEqual([]);
  await p.steering.dispatchEvent('compositionend', { data: '' }); await expect(p.paste).toBeEnabled();
  t.send(JSON.stringify({ type: 'state', mode: 'observe', cols: 80, rows: 24 }));
  await expect(p.paste).toBeDisabled();
  await p.paste.evaluate((element: HTMLButtonElement) => element.click());
  t.send(JSON.stringify({ type: 'state', mode: 'control', cols: 80, rows: 24 }));
  await expect(p.paste).toBeEnabled(); expect(t.input).toEqual([]);
  t.disconnect(); await expect(p.paste).toBeDisabled();
  await p.paste.evaluate((element: HTMLButtonElement) => element.click());
  await expect(t.pane).toHaveAttribute('data-mode', 'observe');
  await expect(p.steering).toHaveValue('Preserve this draft.'); expect(t.input).toEqual([]);
  t.send(JSON.stringify({ type: 'state', mode: 'control', cols: 80, rows: 24 }));
  await expect(p.paste).toBeEnabled(); expect(t.input).toEqual([]);
});

test('steering drafts are separate for each prompt and project and expire on reload', async ({ page }) => {
  await routeCatalog(page);
  const t = await promptTerminal(page), p = await openPrompts(page);
  await p.select.selectOption(steered.id); await p.steering.fill('alpha implementation');
  await p.select.selectOption(another.id); await p.steering.fill('alpha maintenance');
  await p.select.selectOption(steered.id); await expect(p.steering).toHaveValue('alpha implementation');
  await page.keyboard.press('Escape'); await expect(p.dialog).not.toBeVisible();
  await expect(t.pane.locator('.xterm-helper-textarea')).toBeFocused();
  await page.locator('.project-item').filter({ hasText: 'beta' }).click();
  const beta = await openPrompts(page);
  await beta.select.selectOption(steered.id); await expect(beta.steering).toHaveValue('');
  await beta.steering.fill('beta implementation'); await beta.close.click();
  await page.locator('.project-item').filter({ hasText: 'alpha' }).click();
  const alpha = await openPrompts(page);
  await alpha.select.selectOption(steered.id); await expect(alpha.steering).toHaveValue('alpha implementation');
  await alpha.select.selectOption(another.id); await expect(alpha.steering).toHaveValue('alpha maintenance');
  expect(t.input).toEqual([]);
  await page.reload(); await expect(page.locator('.terminal-pane:not([hidden])')).toHaveAttribute('data-mode', 'control');
  const fresh = await openPrompts(page);
  await fresh.select.selectOption(steered.id); await expect(fresh.steering).toHaveValue('');
});

test('catalog errors and empty catalogs recover through reload without stale output', async ({ page }) => {
  let status = 404, prompts: typeof catalog = [], requests = 0;
  await page.route('**/api/v1/prompts', route => { requests++; return route.fulfill({ status, json: { prompts } }); });
  const t = await promptTerminal(page);
  await t.pane.getByRole('button', { name: 'Prompts', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Prompts', exact: true });
  const select = dialog.getByRole('combobox', { name: 'Prompt', exact: true });
  const paste = dialog.getByRole('button', { name: 'Paste into terminal', exact: true });
  const copy = dialog.getByRole('button', { name: 'Copy prompt', exact: true });
  const reload = dialog.getByRole('button', { name: 'Reload prompts', exact: true });
  await expect.poll(() => requests).toBe(1);
  await expect(copy).toBeDisabled(); await expect(paste).toBeDisabled(); await expect(reload).toBeEnabled();
  status = 200; await reload.click(); await expect.poll(() => requests).toBe(2);
  await expect(reload).toBeEnabled(); await expect(copy).toBeDisabled(); await expect(paste).toBeDisabled();
  prompts = catalog; await reload.click(); await expect(select).toBeEnabled();
  await select.selectOption(steered.id); await dialog.getByRole('textbox', { name: 'Steering', exact: true }).fill('Keep this scope.');
  prompts = [{ ...steered, body: '# Revised template\nUse current bytes.\n' }]; await reload.click();
  await expect(dialog.getByRole('textbox', { name: 'Prompt preview', exact: true })).toHaveValue('Keep this scope.\n\n# Revised template\nUse current bytes.');
  status = 503; await reload.click(); await expect(reload).toBeEnabled();
  await expect(copy).toBeDisabled(); await expect(paste).toBeDisabled(); expect(t.input).toEqual([]);
});

test('a late catalog response cannot replace a reopened dialog', async ({ page }) => {
  let requests = 0;
  let delayed: import('@playwright/test').Route | undefined;
  await page.route('**/api/v1/prompts', route => {
    requests++;
    if (requests === 2) { delayed = route; return; }
    return route.fulfill({ json: { prompts: requests === 1 ? catalog : [{ ...steered, body: 'Current template.\n' }] } });
  });
  const t = await promptTerminal(page), p = await openPrompts(page);
  await p.select.selectOption(steered.id); await p.steering.fill('Keep this draft.');
  await p.reload.click(); await expect.poll(() => requests).toBe(2);
  await expect(p.paste).toBeDisabled(); await p.close.click();
  const reopened = await openPrompts(page);
  await expect.poll(() => requests).toBe(3);
  await expect(reopened.preview).toHaveValue('Keep this draft.\n\nCurrent template.');
  await delayed!.fulfill({ json: { prompts: [{ ...steered, body: 'Stale template.' }] } }).catch(() => {});
  await expect(reopened.preview).toHaveValue('Keep this draft.\n\nCurrent template.');
  await expect(reopened.paste).toBeEnabled(); expect(t.input).toEqual([]);
});

for (const theme of ['light', 'dark']) test(`prompt controls fit a short phone viewport in ${theme} theme`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 360 });
  await page.addInitScript(theme => localStorage.setItem('emachine:theme', JSON.stringify(theme)), theme);
  await routeCatalog(page); await promptTerminal(page);
  const p = await openPrompts(page);
  await p.select.selectOption(steered.id); await p.steering.fill('Keep this request readable on the phone.');
  await expect(p.preview).toHaveValue('Keep this request readable on the phone.\n\n# Implement\nApply the request above.');
  const box = await p.dialog.boundingBox(); expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390); expect(box!.y + box!.height).toBeLessThanOrEqual(360);
  expect(await p.dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await p.copy.scrollIntoViewIfNeeded(); await p.copy.click();
  await expect.poll(() => page.evaluate(() => (window as any).promptCopies.length)).toBe(1);
  await p.close.scrollIntoViewIfNeeded(); await p.close.click(); await expect(p.dialog).not.toBeVisible();
});
