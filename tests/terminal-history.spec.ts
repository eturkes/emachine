import { test, expect, type Page, type Route } from '@playwright/test';
// @ts-expect-error The fixture drives the native server.
import { fixture } from './network-helper.mjs';

test.use({ serviceWorkers: 'block' });

const historyRoute = /\/api\/v1\/projects\/[^/]+\/prompt-history(?:\?.*)?$/;
const prompt = (id: string, body: string, incomplete = false) => ({ id, body, timestamp: 1770000000000 - Number(id.replace(/\D/g, '') || 0) * 1000, incomplete });
let machine: any;
let alpha = '';
test.beforeAll(async () => {
  machine = await fixture();
  alpha = (await machine.state()).projects.find((project: any) => project.name === 'alpha').id;
});
test.afterAll(async () => { await machine?.close(); });

async function historyTerminal(page: Page) {
  const input: string[] = [];
  const connections: string[] = [];
  let send!: (data: string | Buffer) => void;
  await page.addInitScript(() => {
    (window as any).historyCopies = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => { (window as any).historyCopies.push(text); },
      readText: async () => '',
    } });
  });
  await page.routeWebSocket(/\/api\/v1\/terminal\//, ws => {
    connections.push(ws.url());
    send = data => ws.send(data);
    ws.onMessage(data => { if (Buffer.isBuffer(data)) input.push(data.toString()); });
    send(JSON.stringify({ type: 'state', mode: 'control', session: 'history-fixture', cols: 80, rows: 24 }));
    send(Buffer.from('history ready\r\n'));
  });
  await page.goto(machine.origin);
  const pane = page.locator('.terminal-pane:not([hidden])');
  await expect(pane).toHaveAttribute('data-mode', 'control');
  await expect(pane.locator('.xterm-rows')).toContainText('history ready');
  return { input, connections, pane, send: (data: string | Buffer) => send(data) };
}

async function openHistory(page: Page) {
  await page.locator('.terminal-pane:not([hidden])').getByRole('button', { name: 'History', exact: true }).click();
  const sidebar = page.getByRole('complementary', { name: 'Prompt history', exact: true });
  await expect(sidebar).toBeVisible();
  const reload = sidebar.getByRole('button', { name: 'Reload history', exact: true });
  await expect(reload).toBeEnabled();
  return {
    sidebar, reload,
    list: sidebar.getByRole('list', { name: 'Prompts, newest first' }),
    entries: sidebar.getByRole('listitem'),
    older: sidebar.getByRole('button', { name: 'Load older', exact: true }),
    close: sidebar.getByRole('button', { name: 'Collapse prompt history', exact: true }),
    status: sidebar.getByRole('status'),
  };
}

test('history toggles a right sidebar without replacing or blocking the terminal', async ({ page }) => {
  await page.route(historyRoute, route => route.fulfill({ json: { prompts: [prompt('entry-1', 'Sidebar request.')], nextCursor: null } }));
  const t = await historyTerminal(page);
  const toggle = t.pane.getByRole('button', { name: 'History', exact: true });
  const host = t.pane.locator('.terminal-host'), rows = t.pane.locator('.xterm-rows');
  const terminal = await t.pane.locator('.xterm').elementHandle();
  const fullHost = (await host.boundingBox())!, fullRows = (await rows.boundingBox())!;
  const panelId = await toggle.getAttribute('aria-controls');
  expect(panelId).toBeTruthy();
  await expect(t.pane.locator('[id="' + panelId + '"]')).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const h = await openHistory(page);
  await expect(h.sidebar).toHaveAttribute('id', panelId!);
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(() => h.sidebar.evaluate(element => element.contains(document.activeElement))).toBe(true);
  const sideBox = (await h.sidebar.boundingBox())!, hostBox = (await host.boundingBox())!;
  const paneBox = (await t.pane.boundingBox())!;
  expect(hostBox.width).toBeGreaterThan(0);
  expect(hostBox.width).toBeLessThan(fullHost.width);
  expect(sideBox.x).toBeGreaterThanOrEqual(hostBox.x + hostBox.width - 1);
  expect(sideBox.x + sideBox.width).toBeCloseTo(paneBox.x + paneBox.width, 0);
  await expect.poll(async () => (await rows.boundingBox())!.width).toBeLessThan(fullRows.width);
  t.send(Buffer.from('sidebar output continues\r\n'));
  await expect(rows).toContainText('sidebar output continues');
  await host.click();
  await expect(t.pane.locator('.xterm-helper-textarea')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect.poll(() => t.input.join('')).toBe('\u001b');
  await expect(h.sidebar).toBeVisible();
  await h.reload.focus(); await page.keyboard.press('Escape');
  await expect(h.sidebar).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(t.pane.locator('.xterm-helper-textarea')).toBeFocused();
  await expect(t.pane.getByRole('button', { name: 'Copy prompt', exact: true })).toHaveCount(0);
  await expect.poll(async () => (await host.boundingBox())!.width).toBe(fullHost.width);
  await expect.poll(async () => (await rows.boundingBox())!.width).toBe(fullRows.width);
  await toggle.click(); await expect(h.sidebar).toBeVisible();
  await toggle.click(); await expect(h.sidebar).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(await t.pane.locator('.xterm').evaluate((element, original) => element === original, terminal)).toBe(true);
  expect(t.connections).toHaveLength(1);
  expect(t.input).toEqual(['\u001b']);
});

test('project history opens from the terminal and stays read-only', async ({ page }, testInfo) => {
  const body = '  Keep this exact request.\n\n<script>window.historyExecuted = true</script>\n';
  const current = prompt('entry-1', body);
  await page.route(historyRoute, route => route.fulfill({ json: { prompts: [current, prompt('entry-2', 'Previous request.', true)], nextCursor: null } }));
  const t = await historyTerminal(page);
  const toggle = t.pane.getByRole('button', { name: 'History', exact: true });
  await expect(toggle).toHaveCount(1);
  await toggle.focus(); await page.keyboard.press('Enter');
  const sidebar = page.getByRole('complementary', { name: 'Prompt history', exact: true });
  await expect(sidebar).toBeVisible();
  await expect(sidebar).toContainText('Claude Code history');
  await expect(sidebar.getByRole('listitem')).toHaveCount(2);
  await expect(sidebar.locator('.history-body').first()).toHaveJSProperty('textContent', body);
  await expect(sidebar.locator('time').first()).toHaveAttribute('datetime', new Date(current.timestamp).toISOString());
  await expect(sidebar).toContainText('Some pasted text could not be loaded');
  expect(await page.evaluate(() => (window as any).historyExecuted)).toBeUndefined();
  t.send(JSON.stringify({ type: 'state', mode: 'observe', cols: 80, rows: 24 }));
  await sidebar.getByRole('button', { name: 'Copy prompt', exact: true }).first().click();
  await expect.poll(() => page.evaluate(() => (window as any).historyCopies)).toEqual([body]);
  expect(t.input).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('history-desktop.png') });
  await page.setViewportSize({ width: 390, height: 360 });
  await page.screenshot({ path: testInfo.outputPath('history-phone.png') });
  await page.keyboard.press('Escape');
  await expect(sidebar).not.toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(t.pane.locator('.xterm-helper-textarea')).toBeFocused();
});

test('older pages append in order and empty pages remain browsable', async ({ page }) => {
  const cursors: (string | null)[] = [];
  const first = Array.from({ length: 8 }, (_, index) => prompt('entry-' + index, 'Current request ' + index + '\n' + 'Readable history line.\n'.repeat(8)));
  await page.route(historyRoute, route => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor'); cursors.push(cursor);
    const data = cursor === null ? { prompts: first, nextCursor: 'older/one?&=' }
      : cursor === 'older/one?&=' ? { prompts: [], nextCursor: 'older-two' }
        : { prompts: [prompt('entry-20', 'Oldest request in this history.')], nextCursor: null };
    return route.fulfill({ json: data });
  });
  const t = await historyTerminal(page), h = await openHistory(page);
  await expect(h.entries).toHaveCount(8);
  await h.list.evaluate(element => { element.scrollTop = element.scrollHeight; });
  const scrollTop = await h.list.evaluate(element => element.scrollTop);
  expect(scrollTop).toBeGreaterThan(0);
  await h.older.click(); await expect(h.older).toBeEnabled();
  await expect(h.entries).toHaveCount(8);
  expect(await h.list.evaluate(element => element.scrollTop)).toBe(scrollTop);
  await h.older.click(); await expect(h.entries).toHaveCount(9);
  await expect(h.entries.last()).toContainText('Oldest request in this history.');
  await expect(h.older).toBeHidden();
  expect(cursors).toEqual([null, 'older/one?&=', 'older-two']);
  await h.reload.click(); await expect(h.entries).toHaveCount(8);
  expect(await h.list.evaluate(element => element.scrollTop)).toBe(0);
  expect(t.input).toEqual([]);
});

test('project histories stay separate, reload current bytes, and are absent from General', async ({ page }) => {
  let alphaBody = 'Alpha request only.';
  await page.route(historyRoute, route => {
    const project = new URL(route.request().url()).pathname.split('/').at(-2);
    return route.fulfill({ json: { prompts: [prompt('entry-1', project === alpha ? alphaBody : 'Beta request only.')], nextCursor: null } });
  });
  const t = await historyTerminal(page);
  const a = await openHistory(page); await expect(a.entries).toContainText('Alpha request only.');
  await page.getByRole('button', { name: 'beta on Test workstation, online', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Prompt history', exact: true })).toHaveCount(0);
  const b = await openHistory(page); await expect(b.entries).toContainText('Beta request only.');
  await expect(b.sidebar).not.toContainText('Alpha request only.');
  alphaBody = 'New alpha request.';
  await page.getByRole('button', { name: 'alpha on Test workstation, online', exact: true }).click();
  await expect(page.locator('.terminal-pane:not([hidden])').getByRole('button', { name: 'History', exact: true })).toHaveAttribute('aria-expanded', 'false');
  const again = await openHistory(page); await expect(again.entries).toContainText(alphaBody);
  await page.getByRole('button', { name: 'General on Test workstation, online', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Prompt history', exact: true })).toHaveCount(0);
  await expect(page.locator('.terminal-pane:not([hidden])').getByRole('button', { name: 'History', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => Object.values(localStorage).some(value => /Alpha request|Beta request|New alpha request/.test(value)))).toBe(false);
  expect(t.input).toEqual([]);
});

test('failed older pages keep visible history and retry the same cursor', async ({ page }) => {
  let fail = true;
  const cursors: (string | null)[] = [];
  const first = Array.from({ length: 6 }, (_, index) => prompt('entry-' + index, 'Keep loaded request ' + index + '\n' + 'History text.\n'.repeat(10)));
  await page.route(historyRoute, route => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor'); cursors.push(cursor);
    if (cursor && fail) return route.fulfill({ status: 503, json: { error: 'temporarily unavailable' } });
    return route.fulfill({ json: cursor ? { prompts: [prompt('entry-9', 'Recovered older request.')], nextCursor: null } : { prompts: first, nextCursor: 'retry-cursor' } });
  });
  await historyTerminal(page); const h = await openHistory(page);
  await h.list.evaluate(element => { element.scrollTop = element.scrollHeight; });
  const scrollTop = await h.list.evaluate(element => element.scrollTop);
  await h.older.click(); await expect(h.status).toContainText('HTTP 503');
  await expect(h.entries).toHaveCount(6); await expect(h.older).toBeEnabled();
  expect(await h.list.evaluate(element => element.scrollTop)).toBe(scrollTop);
  fail = false; await h.older.click(); await expect(h.entries).toHaveCount(7);
  await expect(h.status).not.toContainText('HTTP 503');
  expect(cursors).toEqual([null, 'retry-cursor', 'retry-cursor']);
});

test('changed history asks for reload while keeping the loaded prompts', async ({ page }) => {
  let current = false;
  await page.route(historyRoute, route => {
    if (new URL(route.request().url()).searchParams.has('cursor')) return route.fulfill({ status: 400, json: { error: 'stale history cursor' } });
    return route.fulfill({ json: { prompts: [prompt('entry-1', current ? 'Current file request.' : 'Earlier file request.')], nextCursor: current ? null : 'stale-cursor' } });
  });
  await historyTerminal(page); const h = await openHistory(page);
  await h.older.click(); await expect(h.status).toHaveText('Prompt history changed. Reload history to continue.');
  await expect(h.entries).toContainText('Earlier file request.');
  current = true; await h.reload.click();
  await expect(h.entries).toContainText('Current file request.'); await expect(h.older).toBeHidden();
});

test('empty, unavailable, and invalid history responses recover through reload', async ({ page }) => {
  let status = 404;
  let data: unknown = { prompts: [], nextCursor: null };
  await page.route(historyRoute, route => route.fulfill({ status, json: data }));
  await historyTerminal(page); const h = await openHistory(page);
  await expect(h.status).toContainText('server update');
  await expect(h.entries).toHaveCount(0); await expect(h.older).toBeHidden();
  status = 200; await h.reload.click(); await expect(h.status).toContainText('No Claude Code prompts');
  data = { prompts: [prompt('entry-1', 'Loaded request.')], nextCursor: null };
  await h.reload.click(); await expect(h.entries).toHaveCount(1);
  data = { prompts: [{ ...prompt('entry-2', 'Invalid request.'), timestamp: 'yesterday' }], nextCursor: null };
  await h.reload.click(); await expect(h.status).toContainText('invalid');
  await expect(h.entries).toHaveCount(0);
  data = { prompts: [prompt('entry-3', 'Recovered request.')], nextCursor: null };
  await h.reload.click(); await expect(h.entries).toContainText('Recovered request.');
});

test('late history cannot replace a reopened sidebar', async ({ page }) => {
  let requests = 0;
  let delayed: Route | undefined;
  await page.route(historyRoute, route => {
    requests++;
    if (requests === 2) { delayed = route; return; }
    return route.fulfill({ json: { prompts: [prompt('entry-' + requests, requests === 1 ? 'Initial request.' : 'Current request.')], nextCursor: null } });
  });
  await historyTerminal(page); const h = await openHistory(page);
  await h.reload.click(); await expect.poll(() => requests).toBe(2);
  await h.close.click(); const reopened = await openHistory(page);
  await expect(reopened.entries).toContainText('Current request.');
  await delayed!.fulfill({ json: { prompts: [prompt('entry-2', 'Obsolete delayed request.')], nextCursor: null } }).catch(() => {});
  await expect(reopened.entries).toContainText('Current request.');
  await expect(reopened.sidebar).not.toContainText('Obsolete delayed request.');
});

for (const theme of ['light', 'dark']) test('history scrolls in a short phone viewport in ' + theme + ' theme', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 360 });
  await page.addInitScript(theme => localStorage.setItem('emachine:theme', JSON.stringify(theme)), theme);
  const prompts = Array.from({ length: 12 }, (_, index) => prompt('entry-' + index, 'Phone request ' + index + '\n' + 'word'.repeat(90)));
  await page.route(historyRoute, route => route.fulfill({ json: { prompts, nextCursor: null } }));
  const t = await historyTerminal(page), h = await openHistory(page);
  const box = await h.sidebar.boundingBox(); expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390); expect(box!.y + box!.height).toBeLessThanOrEqual(360);
  expect(await h.sidebar.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await h.list.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await h.entries.last().getByRole('button', { name: 'Copy prompt', exact: true }).scrollIntoViewIfNeeded();
  await h.entries.last().getByRole('button', { name: 'Copy prompt', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).historyCopies)).toEqual([prompts.at(-1)!.body]);
  await h.close.click(); await expect(h.sidebar).not.toBeVisible();
  expect(t.input).toEqual([]);
});
