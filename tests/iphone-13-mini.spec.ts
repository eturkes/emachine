import { devices, expect, test as base, type Locator, type Page } from '@playwright/test';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
// @ts-expect-error This JavaScript fixture owns the native server and its zmx sessions.
import { fixture, root } from './network-helper.mjs';

const test = base.extend({
  baseURL: async ({}, use) => {
    const machine = await fixture({ webRoot: join(root, '.work/iphone-13-mini-web') });
    try {
      // The fixture's real login shell prints the same colored, wrapping output on every run.
      await appendFile(join(machine.home, '.bash_profile'), String.raw`
PS1='\W $ '
printf '\033[2J\033[H\033[1mWorkspace check\033[0m\n\n'
printf '  \033[32mPASS\033[0m  project discovery\n  \033[32mPASS\033[0m  terminal connection\n\n'
printf 'Review the terminal output and switch projects to compare the available space.\n\n'
`);
      await use(machine.origin);
    } finally {
      await machine.close();
    }
  },
});

async function openTerminal(page: Page) {
  await page.goto('/');
  const pane = page.locator('.terminal-pane:not([hidden])');
  await expect(pane).toHaveClass(/terminal-ios/);
  await expect(pane).toHaveAttribute('data-mode', 'control');
  await expect(pane.locator('.xterm-rows')).toContainText('alpha $');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  return pane;
}

async function capture(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  const path = test.info().outputPath(name + '.png');
  const clip = await page.evaluate(() => ({
    x: 0, y: 0, width: visualViewport!.width, height: visualViewport!.height,
  }));
  await page.screenshot({ path, clip, animations: 'disabled', caret: 'hide' });
  await test.info().attach(name, { path, contentType: 'image/png' });
}

async function checkToolbar(pane: Locator) {
  for (const name of ['Toggle terminal keyboard', 'Esc', 'Tab', 'Text']) {
    const control = pane.getByRole('button', { name, exact: true });
    await expect(control).toBeInViewport({ ratio: 1 });
    const bounds = (await control.boundingBox())!;
    expect(Math.min(bounds.width, bounds.height), name + ' touch target').toBeGreaterThanOrEqual(44);
  }
}

test.describe('Portrait', () => {
  test.use({ contextOptions: devices['iPhone 13 Mini'] });
  test('switch projects and send a draft with limited keyboard space', async ({ page }) => {
    const pane = await openTerminal(page);
    await checkToolbar(pane);
    await capture(page, 'portrait-light-terminal');

    await page.getByRole('button', { name: 'Open project drawer' }).tap();
    const beta = page.getByRole('button', { name: 'beta on Test workstation, online' });
    await expect(beta).toBeInViewport({ ratio: 1 });
    await capture(page, 'portrait-project-drawer');
    await beta.tap();
    const rows = pane.locator('.xterm-rows');
    await expect(rows).toContainText('beta $');
    await page.getByRole('button', { name: /^Theme:/ }).tap();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await capture(page, 'portrait-dark-terminal');

    await pane.getByRole('button', { name: 'Text', exact: true }).tap();
    const draft = pane.getByRole('textbox', { name: 'Terminal text' });
    await expect(draft).toBeFocused();
    // iOS shrinks the visual viewport when the keyboard opens. Keep the layout viewport intact.
    const visibleHeight = 400;
    await page.evaluate(height => {
      Object.defineProperty(visualViewport!, 'height', { configurable: true, value: height });
      visualViewport!.dispatchEvent(new Event('resize'));
    }, visibleHeight);
    await draft.fill('echo ready-for-review');
    const send = pane.getByRole('button', { name: 'Send text' });
    for (const element of [draft, send, pane.getByRole('group', { name: 'Terminal controls', exact: true })]) {
      await expect(element).toBeInViewport({ ratio: 1 });
      const box = (await element.boundingBox())!;
      expect(box.y + box.height).toBeLessThanOrEqual(visibleHeight);
    }
    await checkToolbar(pane);
    const lines = rows.locator(':scope > div');
    const lineHeight = (await lines.first().boundingBox())!.height;
    const outputHeight = (await pane.locator('.terminal-host').boundingBox())!.height;
    // The terminal keeps a two-row grid even when only part of the second row fits.
    expect(outputHeight).toBeGreaterThanOrEqual(lineHeight);
    await expect(lines).toHaveCount(Math.max(2, Math.floor(outputHeight / lineHeight)));
    await capture(page, 'portrait-reduced-height-draft');
    await send.tap();
    await expect(draft).toHaveValue('');
    await pane.getByRole('button', { name: 'Enter', exact: true }).tap();
    await expect(rows.locator(':scope > div').filter({ hasText: /^ready-for-review\s*$/ })).toBeVisible();
    await page.getByRole('button', { name: 'Open project drawer' }).tap();
    const machines = page.getByRole('button', { name: 'Machines', exact: true });
    expect(await machines.evaluate(row => row.getBoundingClientRect().bottom)).toBe(visibleHeight);
  });
});

test.describe('Landscape', () => {
  test.use({ contextOptions: devices['iPhone 13 Mini landscape'] });
  test('inspect the sidebar and reclaim terminal width', async ({ page }) => {
    const pane = await openTerminal(page);
    const rows = pane.locator('.xterm-rows');
    const withSidebar = (await rows.boundingBox())!.width;
    await checkToolbar(pane);
    await capture(page, 'landscape-light-sidebar');

    await page.getByRole('button', { name: 'Collapse project sidebar' }).tap();
    await expect.poll(async () => (await rows.boundingBox())!.width).toBeGreaterThan(withSidebar);
    await page.getByRole('button', { name: /^Theme:/ }).tap();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await checkToolbar(pane);
    await capture(page, 'landscape-dark-terminal');
  });
});
