import { test, expect, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
// @ts-expect-error This JavaScript fixture drives the real native server.
import { fixture } from './network-helper.mjs';
// @ts-expect-error Shared neutral-theme gate.
import { neutralTheme } from './theme-contract.mjs';

const exec = promisify(execFile);
async function sessions(f: any) {
  const { stdout } = await exec('zmx', ['list'], { env: f.env, timeout: 5000 });
  return [...stdout.matchAll(/^\s*name=(.*?)\tpid=(\d+)\tclients=(\d+)/gm)]
    .map(([, name, pid, clients]) => ({ name, pid: Number(pid), clients: Number(clients) }))
    .filter(row => /^general(?:[0-9]+)?$/.test(row.name));
}
const general = (page: Page, name = 'Test workstation') => page.getByRole('button', { name: 'General on ' + name + ', online', exact: true });
const pane = (page: Page, name: string) => page.locator('[data-terminal-session="' + name + '"]');
const add = (page: Page) => page.getByRole('button', { name: 'New General terminal', exact: true });

test('General tabs attach lazily, keep pane and daemon lifetimes, and restore monotonic numbering', async ({ page }) => {
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
    for (const name of ['general2', 'general3']) {
      await add(page).click();
      await expect(pane(page, name)).toHaveAttribute('data-mode', 'control');
    }
    await expect(page.getByRole('tab')).toHaveText(['general', 'general2', 'general3']);
    const second = (await sessions(f)).find(row => row.name === 'general2')!;
    expect(second).toBeTruthy();
    await page.getByRole('button', { name: 'Close general2', exact: true }).click();
    await expect(pane(page, 'general2')).toHaveCount(0);
    await expect.poll(async () => (await sessions(f)).find(row => row.name === 'general2')).toEqual({ name: 'general2', pid: second.pid, clients: 0 });
    await page.getByRole('tab', { name: 'general', exact: true }).click();
    await expect(pane(page, 'general')).toHaveAttribute('data-continuity', 'general-kept');
    await page.getByRole('button', { name: 'alpha on Test workstation, online', exact: true }).click();
    await expect(project).toHaveAttribute('data-continuity', 'project-kept');
    await expect(pane(page, 'general')).toBeHidden();
    await general(page).click();
    await expect(pane(page, 'general')).toBeVisible();
    await expect(pane(page, 'general')).toHaveAttribute('data-continuity', 'general-kept');
    await add(page).click();
    await expect(pane(page, 'general4')).toHaveAttribute('data-mode', 'control');
    await page.reload();
    await expect(general(page)).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('tab')).toHaveText(['general', 'general3', 'general4']);
    await expect(page.getByRole('tab', { name: 'general4', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(pane(page, 'general4')).toHaveAttribute('data-mode', 'control');
    await add(page).click();
    await expect(pane(page, 'general5')).toHaveAttribute('data-mode', 'control');
    for (const name of ['general', 'general3', 'general4', 'general5']) {
      await page.getByRole('button', { name: 'Close ' + name, exact: true }).click();
    }
    await expect(page.getByRole('tab')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'No open terminals', exact: true })).toBeVisible();
    await expect(add(page)).toBeVisible();
    await page.getByRole('button', { name: 'Open general', exact: true }).click();
    await expect(pane(page, 'general')).toHaveAttribute('data-mode', 'control');
    await expect.poll(async () => (await sessions(f)).map(row => row.name).sort()).toEqual(['general', 'general2', 'general3', 'general4', 'general5']);
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

test('General tab lists, selections and counters belong to each machine', async ({ page }) => {
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
    await expect(page.getByRole('button', { name: 'General on Test workstation, offline', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('.offline-banner')).toBeVisible();
    await expect(terminal).toHaveAttribute('data-mode', 'disconnected');
    await f.start();
    await expect(general(page)).toHaveAttribute('aria-current', 'page');
    await expect(terminal).toHaveAttribute('data-mode', 'control');
    await expect(terminal).toHaveAttribute('data-continuity', 'reconnected');
    expect((await sessions(f)).find(row => row.name === 'general2')!.pid).toBe(initial.pid);
  } finally { await f.close(); }
});

test('General styling stays neutral and distinct, with keyboard tabs and a reachable plus on phones', async ({ page }) => {
  const f = await fixture();
  try {
    await page.goto(f.origin);
    const row = general(page);
    await expect(row).toBeVisible();
    const styles = await page.locator('.general-item, .project-item').evaluateAll(nodes => nodes.map(node => ({
      general: node.classList.contains('general-item'),
      border: getComputedStyle(node).borderLeftWidth,
    })));
    expect(styles.find(style => style.general)!.border).not.toBe(styles.find(style => !style.general)!.border);
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
        await neutralTheme(page.locator('body'), { tokens: ['bg', 'surface', 'raised', 'text', 'muted', 'accent'], selectors: ['.general-item', '.general-tab', '.new-terminal'], surfaces: ['bg', 'surface', 'raised'] });
        await page.screenshot({ path: 'test-results/general-' + width + '-' + theme + '.png', animations: 'disabled' });
        if (width <= 700) await row.click();
      }
    }
  } finally { await f.close(); }
});
