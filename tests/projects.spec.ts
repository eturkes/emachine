import { test, expect, webkit } from '@playwright/test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { inventory } from '../web/transport';
// @ts-expect-error This JavaScript fixture drives the real native server.
import { fixture } from './network-helper.mjs';
// @ts-expect-error Shared neutral-theme gate.
import { neutralTheme } from './theme-contract.mjs';
// @ts-expect-error Real session metadata fixture with process-identity validation.
import { claudeSession } from './claude-helper.mjs';
// @ts-expect-error Shared pinned WebKit runtime for the real media-query check.
import { webkitOptions } from '../scripts/webkit.mjs';

test('inventory hides snapshots from old servers and offline caches', () => {
  const project = { id: 'alpha', name: 'alpha', path: '', features: [], diagnostics: [] };
  const state = { protocol: 1, machine: { id: 'test', name: 'Test', version: '0.1.0', projectRoot: '' }, projects: [project, { ...project, id: 'snapshots', name: '.snapshots' }] };
  expect(inventory(state).projects.map(p => p.name)).toEqual(['alpha']);
  expect(inventory({ ...state, projects: [{ ...project, phase: 'ITERATE' }] }).projects[0].phase).toBe('ITERATE');
  expect(() => inventory({ ...state, projects: [{ ...project, phase: '<img>' }] })).toThrow();
});

test('sidebar phases update with eligibility and preserve the active terminal', async ({ page }) => {
  const f = await fixture();
  try {
    const root = join(f.config.projectRoot, 'alpha');
    await mkdir(join(root, '.agent'));
    await writeFile(join(root, '.agent/spec.md'), '## Phase\nITERATE. IMPLEMENT is suspended.\n');
    await writeFile(join(root, 'CLAUDE.md'), '@.agent/spec.md\n');
    await mkdir(join(f.config.projectRoot, '.snapshots'));
    await page.goto(f.origin);
    const row = page.locator('.project-item').filter({ has: page.locator('strong', { hasText: /^alpha$/ }) });
    const beta = page.locator('.project-item').filter({ has: page.locator('strong', { hasText: /^beta$/ }) });
    await expect(row.locator('.project-phase')).toHaveText('Iterate');
    await expect(row).toHaveAccessibleName(/phase: Iterate/);
    await expect(beta.locator('.project-phase')).toHaveCount(0);
    await expect(page.locator('.project-list')).not.toContainText('.snapshots');
    await expect(page.getByRole('tab')).toHaveText(['Terminal']);
    await expect(page.locator('.terminal-pane')).toHaveAttribute('data-mode', 'control');
    await page.locator('.terminal-pane').evaluate(node => { (node as HTMLElement).dataset.continuity = 'kept'; });
    await writeFile(join(root, '.agent/spec.md'), 'Phase: MAINTAIN\n');
    await expect(row.locator('.project-phase')).toHaveText('Maintain');
    await expect(page.locator('.terminal-pane')).toHaveAttribute('data-continuity', 'kept');
    await rm(join(root, '.agent/spec.md'));
    await expect(row.locator('.project-phase')).toHaveText('Unknown');
    await rm(join(root, 'CLAUDE.md'));
    await expect(row.locator('.project-phase')).toHaveCount(0);
    await expect(page.locator('.terminal-pane')).toHaveAttribute('data-continuity', 'kept');
  } finally { await f.close(); }
});

test('phase labels remain neutral and readable at desktop and mobile widths', async ({ page }) => {
  const f = await fixture();
  try {
    const name = 'a-project-with-a-long-name';
    const root = join(f.config.projectRoot, name);
    await mkdir(join(root, '.agent'), { recursive: true });
    await writeFile(join(root, 'CLAUDE.md'), '@.agent/spec.md\n');
    await writeFile(join(root, '.agent/spec.md'), 'Phase: IMPLEMENT\n');
    await page.goto(f.origin);
    const row = page.locator('.project-item').filter({ has: page.locator('strong', { hasText: name }) });
    const label = row.locator('.project-phase');
    await expect(label).toHaveText('Implement');
    for (const width of [1360, 720, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      if (width <= 700 && !(await page.locator('.app').getAttribute('class'))?.includes('drawer-open')) {
        await page.getByRole('button', { name: 'Open project drawer', exact: true }).click();
      }
      await expect(label).toBeInViewport({ ratio: 1 });
      expect(await label.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      expect(await row.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await neutralTheme(page.locator('body'), { tokens: ['bg', 'surface', 'raised', 'text', 'muted', 'accent'], selectors: ['.project-phase', '.project-item'], surfaces: ['bg', 'surface', 'raised'] });
        await page.screenshot({ path: `test-results/sidebar-phase-${width}-${theme}.png`, animations: 'disabled' });
      }
    }
  } finally { await f.close(); }
});

test('Claude indicators update inactive projects without replacing terminals and vanish on exit or disconnect', async ({ page }) => {
  const f = await fixture();
  try {
    await page.goto(f.origin);
    const row = page.locator('.project-item').filter({ has: page.locator('strong', { hasText: /^alpha$/ }) });
    const beta = page.locator('.project-item').filter({ has: page.locator('strong', { hasText: /^beta$/ }) });
    await expect(row).toBeVisible();
    const original = await row.innerHTML();
    await expect(row.locator('.claude-status')).toHaveCount(0);
    await expect(page.locator('.terminal-pane')).toHaveAttribute('data-mode', 'control');
    await page.locator('.terminal-pane').evaluate(node => { (node as HTMLElement).dataset.continuity = 'claude-kept'; });
    await beta.click();
    for (const [source, label] of [['busy', 'Working'], ['waiting', 'Waiting'], ['idle', 'Completed']]) {
      await claudeSession(f, source);
      await expect(row.locator('.claude-status')).toHaveText(label);
      await expect(row).toHaveAccessibleName(/Claude Code/);
      await expect(beta.locator('.claude-status')).toHaveCount(0);
      await expect(beta).toHaveAttribute('aria-current', 'page');
      await expect(page.locator('[data-continuity="claude-kept"]')).toHaveCount(1);
    }
    const cache = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('emachine:inventory:')).map(([, value]) => JSON.parse(value)));
    expect(cache.flatMap(state => state.projects).every(project => project.claudeStatus == null)).toBe(true);
    await f.stop();
    await expect(row.locator('.claude-status')).toHaveCount(0);
    await f.start();
    await expect(row.locator('.claude-status')).toHaveText('Completed');
    await rm(join(f.home, `.claude/sessions/${process.pid}.json`));
    await expect(row.locator('.claude-status')).toHaveCount(0);
    await row.click();
    expect(await row.innerHTML()).toBe(original);
    await expect(page.locator('[data-continuity="claude-kept"]')).toBeVisible();
  } finally { await f.close(); }
});

test('Claude indicators fit both themes and phone drawers with reduced motion', async ({ page }) => {
  const f = await fixture();
  try {
    const root = join(f.config.projectRoot, 'alpha');
    await mkdir(join(root, '.agent'));
    await writeFile(join(root, 'CLAUDE.md'), '@.agent/spec.md\n');
    await writeFile(join(root, '.agent/spec.md'), 'Phase: IMPLEMENT\n');
    await claudeSession(f, 'busy');
    await page.goto(f.origin);
    const row = page.locator('.project-item').filter({ has: page.locator('strong', { hasText: /^alpha$/ }) });
    const status = row.locator('.claude-status');
    await expect(status).toHaveText('Working');
    for (const width of [1360, 720, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      if (width <= 700 && !(await page.locator('.app').getAttribute('class'))?.includes('drawer-open')) {
        await page.getByRole('button', { name: 'Open project drawer', exact: true }).click();
      }
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await expect(status).toBeInViewport({ ratio: 1 });
        await expect(row.locator('.project-phase')).toHaveText('Implement');
        expect(await row.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
        expect(await status.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
        await page.screenshot({ path: `test-results/sidebar-claude-${width}-${theme}.png`, animations: 'disabled' });
      }
    }
    // ChromiumFish pins motion preferences; WebKit honors the actual media query.
    const motionBrowser = await webkit.launch(webkitOptions());
    try {
      const motionPage = await motionBrowser.newPage({ reducedMotion: 'reduce' });
      await motionPage.goto(f.origin);
      const icon = motionPage.locator('.claude-status-icon');
      await expect(icon).toBeVisible();
      expect(await motionPage.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
      expect(await icon.evaluate(node => getComputedStyle(node).animationName)).toBe('none');
      await motionPage.emulateMedia({ reducedMotion: 'no-preference' });
      await expect(icon).toHaveCSS('animation-name', 'claude-spin');
      await motionPage.emulateMedia({ reducedMotion: 'reduce' });
      await expect(icon).toHaveCSS('animation-name', 'none');
    } finally { await motionBrowser.close(); }
  } finally { await f.close(); }
});
