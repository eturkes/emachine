import { test, expect, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
// @ts-expect-error This JavaScript fixture drives the real native server.
import { fixture } from './network-helper.mjs';
// @ts-expect-error Real session metadata fixture with process-identity validation.
import { claudeSession } from './claude-helper.mjs';
// @ts-expect-error Shared neutral-theme gate.
import { neutralTheme } from './theme-contract.mjs';

const exec = promisify(execFile);
async function allSessions(f: any) {
  const { stdout } = await exec('zmx', ['list'], { env: f.env, timeout: 5000 });
  return [...stdout.matchAll(/^\s*name=(.*?)\tpid=(\d+)\tclients=(\d+)/gm)]
    .map(([, name, pid, clients]) => ({ name, pid: Number(pid), clients: Number(clients) }));
}
const sessions = async (f: any) => (await allSessions(f)).filter(row => /^general(?:[0-9]+)?$/.test(row.name));
const general = (page: Page, name = 'Test workstation') => page.getByRole('button', { name: name + ', online', exact: true });
const pane = (page: Page, name: string) => page.locator('[data-terminal-session="' + name + '"]');
const add = (page: Page) => page.getByRole('button', { name: 'New General terminal', exact: true });
const editor = (page: Page) => page.getByRole('dialog', { name: 'Choose zmx session', exact: true });

test('General tabs reuse the lowest free name and retain panes and zmx daemons through close and reload', async ({ page }) => {
  const f = await fixture();
  try {
    await page.goto(f.origin);
    const project = page.locator('[data-terminal-project]');
    await expect(project).toHaveAttribute('data-mode', 'control');
    await project.evaluate(node => { (node as HTMLElement).dataset.continuity = 'project-kept'; });
    expect(await sessions(f)).toEqual([]);
    await general(page).click();
    await expect(pane(page, 'general')).toHaveAttribute('data-mode', 'control');
    await pane(page, 'general').evaluate(node => { (node as HTMLElement).dataset.continuity = 'general-kept'; });
    await add(page).click();
    await expect(pane(page, 'general2')).toHaveAttribute('data-mode', 'control');
    const second = (await sessions(f)).find(row => row.name === 'general2')!;
    expect(second).toBeTruthy();
    await page.getByRole('button', { name: 'Close general2', exact: true }).click();
    await expect(pane(page, 'general2')).toHaveCount(0);
    await expect.poll(async () => (await sessions(f)).find(row => row.name === 'general2')).toEqual({ name: 'general2', pid: second.pid, clients: 0 });
    await add(page).click();
    await expect(page.getByRole('tab')).toHaveText(['general', 'general2']);
    await expect(pane(page, 'general2')).toHaveAttribute('data-mode', 'control');
    expect((await sessions(f)).find(row => row.name === 'general2')!.pid).toBe(second.pid);
    for (const name of ['general3', 'general4']) {
      await add(page).click();
      await expect(pane(page, name)).toHaveAttribute('data-mode', 'control');
    }
    const third = (await sessions(f)).find(row => row.name === 'general3')!;
    await page.getByRole('button', { name: 'Close general3', exact: true }).click();
    await expect.poll(async () => (await sessions(f)).find(row => row.name === 'general3')).toEqual({ name: 'general3', pid: third.pid, clients: 0 });
    await page.getByRole('tab', { name: 'general', exact: true }).click();
    await expect(pane(page, 'general')).toHaveAttribute('data-continuity', 'general-kept');
    await page.getByRole('button', { name: 'alpha on Test workstation, online', exact: true }).click();
    await expect(project).toHaveAttribute('data-continuity', 'project-kept');
    await expect(pane(page, 'general')).toBeHidden();
    await general(page).click();
    await expect(pane(page, 'general')).toBeVisible();
    await expect(pane(page, 'general')).toHaveAttribute('data-continuity', 'general-kept');
    await add(page).click();
    await expect(page.getByRole('tab')).toHaveText(['general', 'general2', 'general4', 'general3']);
    await expect(pane(page, 'general3')).toHaveAttribute('data-mode', 'control');
    expect((await sessions(f)).find(row => row.name === 'general3')!.pid).toBe(third.pid);
    await page.reload();
    await expect(general(page)).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('tab')).toHaveText(['general', 'general2', 'general4', 'general3']);
    await expect(page.getByRole('tab', { name: 'general3', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(pane(page, 'general3')).toHaveAttribute('data-mode', 'control');
    await add(page).click();
    await expect(pane(page, 'general5')).toHaveAttribute('data-mode', 'control');
    const original = (await sessions(f)).map(({ name, pid }) => ({ name, pid })).sort((a, b) => a.name.localeCompare(b.name));
    for (const name of ['general', 'general2', 'general3', 'general4', 'general5']) {
      await page.getByRole('button', { name: 'Close ' + name, exact: true }).click();
    }
    await expect(page.getByRole('tab')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'No open terminals', exact: true })).toBeVisible();
    await expect(add(page)).toBeVisible();
    await add(page).click();
    await expect(pane(page, 'general')).toHaveAttribute('data-mode', 'control');
    await expect(page.getByRole('tab')).toHaveText(['general']);
    expect((await sessions(f)).map(({ name, pid }) => ({ name, pid })).sort((a, b) => a.name.localeCompare(b.name))).toEqual(original);
  } finally { await f.close(); }
});

test('General ignores legacy counters and finds holes after reloading saved tabs', async ({ page }) => {
  const f = await fixture();
  try {
    await page.goto(f.origin);
    const key = (await f.state()).machine.id + ':@general';
    await page.evaluate(key => {
      localStorage.setItem('emachine:selection', JSON.stringify(key));
      localStorage.setItem('emachine:tabs', JSON.stringify({ [key]: 'general3' }));
      localStorage.setItem('emachine:general-tabs', JSON.stringify({ [key]: { sessions: ['general', 'general3'], next: Number.MAX_SAFE_INTEGER } }));
    }, key);
    await page.reload();
    await expect(page.getByRole('tab')).toHaveText(['general', 'general3']);
    await expect(pane(page, 'general3')).toHaveAttribute('data-mode', 'control');
    await expect(add(page)).toBeEnabled();
    await add(page).click();
    await expect(page.getByRole('tab')).toHaveText(['general', 'general3', 'general2']);
    await expect(pane(page, 'general2')).toHaveAttribute('data-mode', 'control');
    await page.getByRole('button', { name: 'Close general', exact: true }).click();
    await page.reload();
    await expect(page.getByRole('tab')).toHaveText(['general3', 'general2']);
    await add(page).click();
    await expect(page.getByRole('tab')).toHaveText(['general3', 'general2', 'general']);
    await expect(pane(page, 'general')).toHaveAttribute('data-mode', 'control');
  } finally { await f.close(); }
});

test('General session editor creates and reattaches exact named sessions without ending either daemon', async ({ page }) => {
  const f = await fixture();
  const name = 'Notes \u65e5\u672c-2.1';
  try {
    await page.goto(f.origin);
    await general(page).click();
    await add(page).click();
    await expect(pane(page, 'general2')).toHaveAttribute('data-mode', 'control');
    const previous = (await allSessions(f)).find(row => row.name === 'general2')!;
    await page.getByRole('tab', { name: 'general2', exact: true }).dblclick();
    await expect(editor(page)).toBeVisible();
    await expect(editor(page).getByLabel('Session name', { exact: true })).toHaveValue('general2');
    await editor(page).getByLabel('Session name', { exact: true }).fill(name);
    await editor(page).getByRole('button', { name: 'Open session', exact: true }).click();
    await expect(editor(page)).toHaveCount(0);
    await expect(page.getByRole('tab')).toHaveText(['general', name]);
    await expect(pane(page, name)).toHaveAttribute('data-mode', 'control');
    await expect(pane(page, 'general2')).toHaveCount(0);
    await expect.poll(async () => (await allSessions(f)).find(row => row.name === 'general2')).toEqual({ ...previous, clients: 0 });
    const named = (await allSessions(f)).find(row => row.name === name)!;
    expect(named).toBeTruthy();
    await page.getByRole('button', { name: 'Close ' + name, exact: true }).click();
    await expect.poll(async () => (await allSessions(f)).find(row => row.name === name)).toEqual({ ...named, clients: 0 });
    await add(page).click();
    await expect(pane(page, 'general2')).toHaveAttribute('data-mode', 'control');
    expect((await allSessions(f)).find(row => row.name === 'general2')!.pid).toBe(previous.pid);
    await page.getByRole('tab', { name: 'general2', exact: true }).dblclick();
    await editor(page).getByLabel('Session name', { exact: true }).fill(name);
    await editor(page).getByRole('button', { name: 'Open session', exact: true }).click();
    await expect(pane(page, name)).toHaveAttribute('data-mode', 'control');
    expect((await allSessions(f)).find(row => row.name === name)!.pid).toBe(named.pid);
    await page.reload();
    await expect(page.getByRole('tab')).toHaveText(['general', name]);
    await expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(pane(page, name)).toHaveAttribute('data-mode', 'control');
    expect((await allSessions(f)).find(row => row.name === name)!.pid).toBe(named.pid);
    expect((await allSessions(f)).find(row => row.name === 'general2')!.pid).toBe(previous.pid);
  } finally { await f.close(); }
});

test('General session editor handles inactive tabs, cancellation, invalid names, no-op and an already open target', async ({ page }) => {
  const f = await fixture();
  try {
    await page.goto(f.origin);
    await general(page).click();
    await expect(pane(page, 'general')).toHaveAttribute('data-mode', 'control');
    await pane(page, 'general').evaluate(node => { (node as HTMLElement).dataset.continuity = 'target-kept'; });
    for (const name of ['general2', 'general3']) {
      await add(page).click();
      await expect(pane(page, name)).toHaveAttribute('data-mode', 'control');
      await pane(page, name).evaluate(node => { (node as HTMLElement).dataset.continuity = 'source-kept'; });
    }
    const original = await sessions(f);
    await page.getByRole('tab', { name: 'general2', exact: true }).dblclick();
    await expect(editor(page)).toBeVisible();
    await expect(editor(page).getByLabel('Session name', { exact: true })).toHaveValue('general2');
    await editor(page).getByLabel('Session name', { exact: true }).fill('discarded-draft');
    await editor(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(editor(page)).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'general2', exact: true })).toBeFocused();
    await expect(pane(page, 'general2')).toHaveAttribute('data-continuity', 'source-kept');
    expect((await allSessions(f)).some(row => row.name === 'discarded-draft')).toBe(false);
    await page.keyboard.press('F2');
    await expect(editor(page)).toBeVisible();
    const composing = editor(page).getByLabel('Session name', { exact: true });
    await composing.fill('composition-draft');
    await composing.dispatchEvent('compositionstart');
    await composing.press('Enter');
    await expect(editor(page)).toBeVisible();
    await composing.dispatchEvent('compositionend');
    await composing.evaluate(node => {
      node.addEventListener('keydown', event => Object.defineProperty(event, 'keyCode', { value: 229 }), { capture: true, once: true });
    });
    await composing.press('Enter');
    await expect(editor(page)).toBeVisible();
    expect((await allSessions(f)).some(row => row.name === 'composition-draft')).toBe(false);
    for (const invalid of ['', '..', '-session', 'bad/name', 'bad\\name', ' leading', '\u754c'.repeat(17)]) {
      await editor(page).getByLabel('Session name', { exact: true }).fill(invalid);
      await editor(page).getByRole('button', { name: 'Open session', exact: true }).click();
      await expect(editor(page)).toBeVisible();
      await expect(page.getByRole('tab')).toHaveText(['general', 'general2', 'general3']);
      await expect(pane(page, 'general2')).toHaveAttribute('data-continuity', 'source-kept');
    }
    await editor(page).getByLabel('Session name', { exact: true }).fill('general2');
    await editor(page).getByLabel('Session name', { exact: true }).press('Enter');
    await expect(editor(page)).toHaveCount(0);
    await expect(pane(page, 'general2')).toHaveAttribute('data-continuity', 'source-kept');
    await page.getByRole('tab', { name: 'general2', exact: true }).press('F2');
    await editor(page).getByLabel('Session name', { exact: true }).fill('general');
    await editor(page).getByRole('button', { name: 'Open session', exact: true }).click();
    await expect(page.getByRole('tab')).toHaveText(['general', 'general3']);
    await expect(page.getByRole('tab', { name: 'general', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(pane(page, 'general')).toHaveCount(1);
    await expect(pane(page, 'general')).toHaveAttribute('data-continuity', 'target-kept');
    await expect(pane(page, 'general3')).toHaveAttribute('data-continuity', 'source-kept');
    await expect(pane(page, 'general2')).toHaveCount(0);
    await expect.poll(async () => (await sessions(f)).find(row => row.name === 'general2')!.clients).toBe(0);
    expect((await sessions(f)).map(({ name, pid }) => ({ name, pid }))).toEqual(original.map(({ name, pid }) => ({ name, pid })));
  } finally { await f.close(); }
});

test('General remains available without any projects', async ({ page }) => {
  const f = await fixture();
  try {
    for (const name of ['alpha', 'beta']) await rm(join(f.config.projectRoot, name), { recursive: true });
    await expect.poll(async () => (await f.state()).projects.length).toBe(0);
    await page.goto(f.origin);
    await expect(general(page)).toBeVisible();
    await expect(page.locator('.project-item')).toHaveCount(0);
    await expect(general(page)).toHaveAttribute('aria-current', 'page');
    await expect(pane(page, 'general')).toHaveAttribute('data-mode', 'control');
    await add(page).click();
    await expect(pane(page, 'general2')).toHaveAttribute('data-mode', 'control');
  } finally { await f.close(); }
});

test('machine sidebar row names the machine and shows live non-project Claude activity', async ({ page }) => {
  const name = 'My workstation';
  const f = await fixture({ name });
  try {
    await claudeSession(f, 'waiting');
    await page.goto(f.origin);
    const row = page.locator('.general-item');
    const status = row.locator('.claude-status');
    await expect(page.locator('.project-item .claude-status')).toHaveText('Waiting');
    expect.soft(await row.innerText()).toBe(name);
    await expect(status).toHaveCount(0);

    for (const [source, label] of [['busy', 'Working'], ['idle', 'Completed'], ['waiting', 'Waiting']]) {
      await claudeSession(f, source, { cwd: f.home });
      await expect(status).toHaveText(label);
      await expect(row).toHaveAccessibleName(new RegExp(name + '.*Claude Code: ' + label));
      await expect(page.locator('.project-item .claude-status')).toHaveCount(0);
    }
    for (const width of [1360, 320]) {
      await page.setViewportSize({ width, height: 900 });
      if (width === 320) await page.getByRole('button', { name: 'Open project drawer', exact: true }).click();
      await expect(status).toBeInViewport({ ratio: 1 });
      const title = (await row.locator('strong').boundingBox())!;
      const badge = (await status.boundingBox())!;
      expect(badge.x).toBeGreaterThanOrEqual(title.x + title.width);
      expect(Math.abs((title.y + title.height / 2) - (badge.y + badge.height / 2))).toBeLessThan(2);
    }
    await f.stop();
    await expect(row).toHaveAccessibleName(name + ', offline');
    await expect(status).toHaveCount(0);
    await f.start();
    await expect(status).toHaveText('Waiting');
    await rm(join(f.home, `.claude/sessions/${process.pid}.json`));
    await expect(status).toHaveCount(0);
    await expect(row).toHaveAccessibleName(name + ', online');
  } finally { await f.close(); }
});

test('General tab lists, selections and available names belong to each machine', async ({ page }) => {
  const a = await fixture({ name: 'Machine A' });
  const b = await fixture({ name: 'Machine B', origins: [a.origin] });
  try {
    await page.goto(a.origin);
    await general(page, 'Machine A').click();
    await expect(page.locator('.terminal-pane:not([hidden])')).toHaveAttribute('data-mode', 'control');
    await add(page).click();
    await expect(pane(page, 'general2')).toHaveAttribute('data-mode', 'control');
    await page.getByRole('tab', { name: 'general', exact: true }).click();
    await page.getByRole('button', { name: 'Machine settings', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill('Remote B');
    await page.getByLabel('Direct address', { exact: true }).fill(b.origin + '/');
    await page.getByRole('button', { name: 'Connect machine', exact: true }).click();
    await general(page, 'Machine B').click();
    await expect(page.getByRole('tab')).toHaveText(['general']);
    await expect(page.locator('.terminal-pane:not([hidden])')).toHaveAttribute('data-mode', 'control');
    for (const name of ['general2', 'general3']) {
      await add(page).click();
      await expect(page.locator('.terminal-pane:not([hidden])')).toHaveAttribute('data-terminal-session', name);
      await expect(page.locator('.terminal-pane:not([hidden])')).toHaveAttribute('data-mode', 'control');
    }
    await general(page, 'Machine A').click();
    await expect(page.getByRole('tab')).toHaveText(['general', 'general2']);
    await expect(page.getByRole('tab', { name: 'general', exact: true })).toHaveAttribute('aria-selected', 'true');
    await add(page).click();
    await expect(page.getByRole('tab')).toHaveText(['general', 'general2', 'general3']);
    await expect(page.locator('.terminal-pane:not([hidden])')).toHaveAttribute('data-mode', 'control');
    await general(page, 'Machine B').click();
    await expect(page.getByRole('tab', { name: 'general3', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.reload();
    await expect(general(page, 'Machine B')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('tab')).toHaveText(['general', 'general2', 'general3']);
    await expect(page.getByRole('tab', { name: 'general3', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect.poll(async () => (await sessions(a)).map(row => row.name).sort()).toEqual(['general', 'general2', 'general3']);
    await expect.poll(async () => (await sessions(b)).map(row => row.name).sort()).toEqual(['general', 'general2', 'general3']);
  } finally { await b.close(); await a.close(); }
});

test('General reconnects the retained pane and session after the server restarts', async ({ page }) => {
  const f = await fixture();
  try {
    await page.goto(f.origin);
    await general(page).click();
    await add(page).click();
    const terminal = pane(page, 'general2');
    await expect(terminal).toHaveAttribute('data-mode', 'control');
    await terminal.evaluate(node => { (node as HTMLElement).dataset.continuity = 'reconnected'; });
    const initial = (await sessions(f)).find(row => row.name === 'general2')!;
    await f.stop();
    await expect(page.getByRole('button', { name: 'Test workstation, offline', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('.offline-banner')).toBeVisible();
    await expect(terminal).toHaveAttribute('data-mode', 'disconnected');
    await f.start();
    await expect(general(page)).toHaveAttribute('aria-current', 'page');
    await expect(terminal).toHaveAttribute('data-mode', 'control');
    await expect(terminal).toHaveAttribute('data-continuity', 'reconnected');
    expect((await sessions(f)).find(row => row.name === 'general2')!.pid).toBe(initial.pid);
  } finally { await f.close(); }
});

test('General stays compact and neutral, with keyboard tabs and a reachable plus on phones', async ({ page }) => {
  const f = await fixture();
  try {
    await page.goto(f.origin);
    const row = general(page);
    await expect(row).toBeVisible();
    await row.click();
    for (const name of ['general2', 'general3', 'general4', 'general5', 'general6']) {
      await add(page).click();
      await expect(pane(page, name)).toHaveAttribute('data-mode', 'control');
    }
    await page.getByRole('tab', { name: 'general6', exact: true }).focus();
    await page.keyboard.press('Home');
    await expect(page.getByRole('tab', { name: 'general', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Close general', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(add(page)).toBeFocused();
    await page.getByRole('tab', { name: 'general', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'general2', exact: true })).toBeFocused();
    await page.keyboard.press('Delete');
    await expect(page.getByRole('tab', { name: 'general2', exact: true })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'general3', exact: true })).toBeFocused();
    for (const width of [1360, 720, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(add(page)).toBeInViewport({ ratio: 1 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (width <= 700) {
        expect(await page.locator('.tabs').evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
      }
      for (const theme of ['light', 'dark']) {
        if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: /^Theme:/ }).click();
        await page.screenshot({ path: 'test-results/general-tabs-' + width + '-' + theme + '.png', animations: 'disabled' });
        if (width <= 700) await page.getByRole('button', { name: 'Open project drawer', exact: true }).click();
        await expect(row).toBeInViewport({ ratio: 1 });
        const styles = await page.locator('.general-item, .project-item').evaluateAll(nodes => nodes.map(node => {
          const title = node.querySelector('strong')!;
          const bounds = node.getBoundingClientRect(); const heading = title.getBoundingClientRect();
          return { general: node.classList.contains('general-item'), height: bounds.height, left: heading.left,
            border: getComputedStyle(node).borderLeftWidth, weight: getComputedStyle(title).fontWeight,
            fits: node.scrollWidth <= node.clientWidth };
        }));
        const generalStyle = styles.find(style => style.general)!; const projectStyle = styles.find(style => !style.general)!;
        expect(generalStyle.height).toBeGreaterThanOrEqual(width <= 700 ? 44 : 40);
        expect(generalStyle.height).toBeLessThan(projectStyle.height);
        expect(generalStyle.left).toBeCloseTo(projectStyle.left, 0);
        expect(generalStyle.border).toBe(projectStyle.border);
        expect(generalStyle.weight).toBe(projectStyle.weight);
        expect(generalStyle.fits).toBe(true);
        await neutralTheme(page.locator('body'), { tokens: ['bg', 'surface', 'raised', 'text', 'muted', 'accent'], selectors: ['.general-item', '.general-tab', '.new-terminal'], surfaces: ['bg', 'surface', 'raised'] });
        await page.screenshot({ path: 'test-results/general-' + width + '-' + theme + '.png', animations: 'disabled' });
        if (width <= 700) await row.click();
      }
    }
  } finally { await f.close(); }
});

test.describe('General mobile session tabs', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 740 } });

  test('a touch context menu before the hold timer preserves the editor and its input focus after release', async ({ page }) => {
    const f = await fixture();
    try {
      await page.goto(f.origin);
      await page.getByRole('button', { name: 'Open project drawer', exact: true }).click();
      await general(page).click();
      await add(page).click();
      await expect(pane(page, 'general2')).toHaveAttribute('data-mode', 'control');
      const tab = page.locator('.general-tab [data-tab-id="general"]');
      const pointer = { pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1, clientX: 110, clientY: 25 };
      await page.clock.install();
      for (const target of ['tab', 'backdrop']) {
        await tab.dispatchEvent('pointerdown', pointer);
        await page.clock.runFor(100);
        await tab.dispatchEvent('contextmenu', { button: 2, clientX: 110, clientY: 25 });
        await expect(editor(page)).toBeVisible();
        const input = editor(page).getByLabel('Session name', { exact: true });
        await expect(input).toHaveValue('general');
        await expect(input).toBeFocused();
        await tab.dispatchEvent('pointerup', { ...pointer, buttons: 0 });
        await (target === 'tab' ? tab : editor(page)).dispatchEvent('click', { detail: 1, clientX: 0, clientY: 0 });
        await page.clock.runFor(650);
        await expect(editor(page)).toHaveCount(1);
        await expect(editor(page)).toBeVisible();
        await expect(input).toBeFocused();
        await expect(page.getByRole('tab', { name: 'general2', exact: true })).toHaveAttribute('aria-selected', 'true');
        await editor(page).getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(editor(page)).toHaveCount(0);
      }
      await page.clock.resume();
    } finally { await f.close(); }
  });

  test('a canceled long press without a compatibility click still allows keyboard tab activation', async ({ page }) => {
    const f = await fixture();
    try {
      await page.goto(f.origin);
      await page.getByRole('button', { name: 'Open project drawer', exact: true }).click();
      await general(page).click();
      await add(page).click();
      await expect(pane(page, 'general2')).toHaveAttribute('data-mode', 'control');
      const tab = page.locator('.general-tab [data-tab-id="general"]');
      const pointer = { pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1, clientX: 110, clientY: 25 };
      await page.clock.install();
      await tab.dispatchEvent('pointerdown', pointer);
      await page.clock.runFor(650);
      await expect(editor(page)).toBeVisible();
      await tab.dispatchEvent('pointerup', { ...pointer, buttons: 0 });
      await page.keyboard.press('Escape');
      await expect(editor(page)).toHaveCount(0);
      await expect(tab).toBeFocused();
      await expect(page.getByRole('tab', { name: 'general2', exact: true })).toHaveAttribute('aria-selected', 'true');
      await tab.press('Enter');
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      await expect(pane(page, 'general')).toBeVisible();
      await expect(editor(page)).toHaveCount(0);
      await page.clock.resume();
    } finally { await f.close(); }
  });

  test('long press opens the session editor while taps, scrolling, cancellation and close controls do not', async ({ page, browserName }) => {
    const f = await fixture();
    try {
      await page.goto(f.origin);
      await page.getByRole('button', { name: 'Open project drawer', exact: true }).click();
      await general(page).click();
      await expect(pane(page, 'general')).toHaveAttribute('data-mode', 'control');
      await add(page).click();
      await expect(pane(page, 'general2')).toHaveAttribute('data-mode', 'control');
      const original = await sessions(f);
      const tab = page.locator('.general-tab [data-tab-id="general"]');
      const close = page.getByRole('button', { name: 'Close general2', exact: true });
      const pointer = { pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1, clientX: 110, clientY: 25 };
      await page.clock.install();

      await tab.dispatchEvent('pointerdown', pointer);
      await page.clock.runFor(200);
      await tab.dispatchEvent('pointerup', { ...pointer, buttons: 0 });
      await page.clock.runFor(650);
      await expect(editor(page)).toHaveCount(0);

      await tab.dispatchEvent('pointerdown', pointer);
      await tab.dispatchEvent('pointermove', { ...pointer, clientX: 155 });
      await tab.dispatchEvent('pointermove', pointer);
      await page.clock.runFor(650);
      await expect(editor(page)).toHaveCount(0);
      await tab.dispatchEvent('pointerup', { ...pointer, buttons: 0 });

      await tab.dispatchEvent('pointerdown', pointer);
      await tab.dispatchEvent('pointercancel', pointer);
      await page.clock.runFor(650);
      await expect(editor(page)).toHaveCount(0);

      await tab.dispatchEvent('pointerdown', { ...pointer, pointerType: 'mouse' });
      await page.clock.runFor(650);
      await expect(editor(page)).toHaveCount(0);
      await tab.dispatchEvent('pointerup', { ...pointer, pointerType: 'mouse', buttons: 0 });

      await close.dispatchEvent('pointerdown', pointer);
      await page.clock.runFor(650);
      await expect(editor(page)).toHaveCount(0);
      await close.dispatchEvent('pointerup', { ...pointer, buttons: 0 });
      await expect(page.getByRole('tab')).toHaveText(['general', 'general2']);

      await tab.dispatchEvent('pointerdown', pointer);
      await page.clock.runFor(650);
      await expect(editor(page)).toBeVisible();
      await expect(editor(page).getByLabel('Session name', { exact: true })).toHaveValue('general');
      await tab.dispatchEvent('pointerup', { ...pointer, buttons: 0 });
      await tab.dispatchEvent('click', { detail: 1 });
      await expect(editor(page)).toHaveCount(1);
      await expect(editor(page)).toBeVisible();
      await page.clock.resume();

      await page.setViewportSize({ width: 390, height: 380 });
      await expect(editor(page)).toBeInViewport({ ratio: 1 });
      await expect(editor(page).getByLabel('Session name', { exact: true })).toBeInViewport({ ratio: 1 });
      await expect(editor(page).getByRole('button', { name: 'Open session', exact: true })).toBeInViewport({ ratio: 1 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: 'test-results/general-session-mobile-' + browserName + '.png', animations: 'disabled' });
      await editor(page).getByLabel('Session name', { exact: true }).fill('mobile session');
      await editor(page).getByRole('button', { name: 'Open session', exact: true }).tap();
      await expect(page.getByRole('tab')).toHaveText(['mobile session', 'general2']);
      await expect(pane(page, 'mobile session')).toHaveAttribute('data-mode', 'control');
      await expect.poll(async () => (await sessions(f)).find(row => row.name === 'general')!.clients).toBe(0);
      expect((await sessions(f)).map(({ name, pid }) => ({ name, pid }))).toEqual(original.map(({ name, pid }) => ({ name, pid })));
      await page.getByRole('button', { name: 'Close general2', exact: true }).tap();
      await expect(page.getByRole('tab', { name: 'general2', exact: true })).toHaveCount(0);
      await expect(editor(page)).toHaveCount(0);
      expect((await sessions(f)).find(row => row.name === 'general2')!.pid).toBe(original.find(row => row.name === 'general2')!.pid);
    } finally { await f.close(); }
  });
});
