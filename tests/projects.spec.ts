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

test('inventory hides .pnpm-store from old servers and offline caches without hiding other directories', () => {
  const names = ['alpha', '.snapshots', '.pnpm-store', '.visible', '.pnpm-store-backup', 'pnpm-store'];
  const state = {
    protocol: 1, machine: { id: 'test', name: 'Test', version: '0.1.0', projectRoot: '' },
    projects: names.map((name, i) => ({ id: `project-${i}`, name, path: '', features: [], diagnostics: [] })),
  };
  expect(inventory(state).projects.map(p => p.name)).toEqual(['alpha', '.visible', '.pnpm-store-backup', 'pnpm-store']);
  expect(state.projects.map(p => p.name)).toEqual(names);
});

test('sidebar phases update with eligibility and preserve the active terminal', async ({ page }) => {
  const f = await fixture();
  try {
    const root = join(f.config.projectRoot, 'alpha');
    await mkdir(join(root, '.agent'));
    await writeFile(join(root, '.agent/spec.md'), '## Phase\nITERATE. IMPLEMENT is suspended.\n');
    await writeFile(join(root, 'CLAUDE.md'), '@.agent/spec.md\n');
    await mkdir(join(f.config.projectRoot, '.snapshots'));
    await mkdir(join(f.config.projectRoot, '.pnpm-store'));
    await page.goto(f.origin);
    const row = page.locator('.project-item').filter({ has: page.locator('strong', { hasText: /^alpha$/ }) });
    const beta = page.locator('.project-item').filter({ has: page.locator('strong', { hasText: /^beta$/ }) });
    await expect(row.locator('.project-phase')).toHaveText('Iterate');
    await expect(row).toHaveAccessibleName(/phase: Iterate/);
    await expect(beta.locator('.project-phase')).toHaveCount(0);
    await expect(page.locator('.project-list')).not.toContainText('.snapshots');
    await expect(page.locator('.project-list')).not.toContainText('.pnpm-store');
    await expect(page.getByRole('tab')).toHaveText(['Terminal']);
    await expect(page.locator('.terminal-pane')).toHaveAttribute('data-mode', 'control');
    await page.locator('.terminal-pane').evaluate(node => { (node as HTMLElement).dataset.continuity = 'kept'; });
    await writeFile(join(root, '.agent/spec.md'), 'Phase: MAINTAIN\n');
    await expect(row.locator('.project-phase')).toHaveText('Maintain');
    await expect(page.locator('.terminal-pane')).toHaveAttribute('data-continuity', 'kept');
    await writeFile(join(root, '.agent/spec.md'), '## Phase\nITERATE \u2014 dashboard\n> Phase: PROTOTYPE\nSuspended: IMPLEMENT \u2014 whole product\n');
    await expect(row.locator('.project-phase')).toHaveText('Iterate');
    await writeFile(join(root, '.agent/spec.md'), '## Phase\nITERATE \u2014 \n');
    await expect(row.locator('.project-phase')).toHaveText('Unknown');
    await writeFile(join(root, '.agent/spec.md'), '## Phase\nIMPLEMENT \u2014 API\nSuspended: MAINTAIN \u2014 CLI\n');
    await expect(row.locator('.project-phase')).toHaveText('Implement');
    await writeFile(join(root, '.agent/spec.md'), '## Phase\nIMPLEMENT \u2014 API\nMAINTAIN \u2014 CLI\n');
    await expect(row.locator('.project-phase')).toHaveText('Unknown');
    await expect(page.locator('.terminal-pane')).toHaveAttribute('data-continuity', 'kept');
    await writeFile(join(root, '.agent/spec.md'), '## Phase\nMAINTAIN \u2014 whole product\n');
    await expect(row.locator('.project-phase')).toHaveText('Maintain');
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
    for (const [source, label] of [['shell', 'Working'], ['busy', 'Working'], ['waiting', 'Waiting'], ['shell', 'Working'], ['idle', 'Completed']]) {
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

test('header waiting indicator reveals a filtered hidden project without changing the active terminal', async ({ page }) => {
  const f = await fixture();
  try {
    await page.goto(f.origin);
    const alpha = page.locator('.project-item').filter({ has: page.locator('strong', { hasText: /^alpha$/ }) });
    const beta = page.locator('.project-item').filter({ has: page.locator('strong', { hasText: /^beta$/ }) });
    await beta.click();
    const pane = page.locator('.terminal-pane:not([hidden])');
    await expect(pane).toHaveAttribute('data-mode', 'control');
    const terminal = await pane.locator('.xterm').elementHandle();
    const selection = await page.evaluate(() => localStorage.getItem('emachine:selection'));
    await page.getByRole('searchbox', { name: 'Filter projects' }).fill('beta');
    await page.getByRole('button', { name: 'Collapse project sidebar', exact: true }).click();
    const waiting = page.locator('.tab-header .waiting-projects');
    await expect(waiting).toBeHidden();
    const session = await claudeSession(f, 'waiting');
    await expect(waiting).toHaveText('Waiting (1)');
    await expect(waiting).toHaveAccessibleName('1 project waiting for input. Show projects.');
    await expect(waiting).toHaveAttribute('title', /alpha on Test workstation/);
    await expect(waiting).toHaveAttribute('aria-controls', 'project-sidebar');
    await expect(page.locator('#project-sidebar')).toBeHidden();
    await expect(page.locator('.waiting-announcement')).toContainText('1 project waiting for input');
    await waiting.focus(); await page.keyboard.press('Enter');
    await expect(page.locator('#project-sidebar')).toBeVisible();
    await expect(page.getByRole('searchbox', { name: 'Filter projects' })).toHaveValue('');
    await expect(alpha).toBeFocused();
    await expect(alpha).toBeInViewport({ ratio: 1 });
    await expect(beta).toHaveAttribute('aria-current', 'page');
    expect(await page.evaluate(() => localStorage.getItem('emachine:selection'))).toBe(selection);
    expect(await pane.locator('.xterm').evaluate((node, original) => node === original, terminal)).toBe(true);
    for (const source of ['busy', 'idle']) {
      await claudeSession(f, source);
      await expect(waiting).toBeHidden();
      await expect(page.locator('.waiting-announcement')).toHaveText('No projects waiting for input.');
      await claudeSession(f, 'waiting');
      await expect(waiting).toHaveText('Waiting (1)');
    }
    await rm(session.path);
    await expect(waiting).toBeHidden();
    await page.locator('.general-item').click();
    await claudeSession(f, 'waiting');
    await expect(waiting).toHaveText('Waiting (1)');
    await expect(page.getByRole('tab', { name: 'general', exact: true })).toHaveAttribute('aria-selected', 'true');
    await rm(join(f.config.projectRoot, 'alpha'), { recursive: true });
    await expect(waiting).toBeHidden();
  } finally { await f.close(); }
});

test('header waiting indicator counts unique online projects across machines and clears stale activity', async ({ page }) => {
  const a = await fixture({ name: 'Waiting A' });
  const b = await fixture({ name: 'Waiting B', origins: [a.origin] });
  try {
    await claudeSession(a, 'waiting'); await claudeSession(b, 'waiting');
    await page.addInitScript(({ first, second }) => {
      localStorage.setItem('emachine:connections:v1', JSON.stringify([
        { key: 'first', name: 'Waiting A', direct: first },
        { key: 'duplicate', name: 'Same machine again', direct: first },
        { key: 'second', name: 'Waiting B', direct: second },
      ]));
      localStorage.setItem('emachine:sidebar-collapsed', 'true');
    }, { first: a.origin, second: b.origin });
    await page.goto(a.origin);
    const waiting = page.locator('.tab-header .waiting-projects');
    await expect(waiting).toHaveText('Waiting (2)');
    await expect(waiting).toHaveAccessibleName('2 projects waiting for input. Show projects.');
    await expect(waiting).toHaveAttribute('title', /alpha on Waiting A/);
    await expect(waiting).toHaveAttribute('title', /alpha on Waiting B/);
    await expect(page.locator('.machine-count')).toHaveText('2 of 2 machines online');
    await b.stop();
    await expect(waiting).toHaveText('Waiting (1)');
    await expect(waiting).not.toHaveAttribute('title', /Waiting B/);
    await claudeSession(a, 'idle');
    await expect(waiting).toBeHidden();
    await page.reload();
    await expect(page.locator('.machine-count')).toHaveText('1 of 2 machines online');
    await expect(waiting).toBeHidden();
    await b.start();
    await expect(waiting).toHaveText('Waiting (1)');
    await expect(waiting).toHaveAttribute('title', /alpha on Waiting B/);
  } finally { await b.close(); await a.close(); }
});

for (const engine of ['chromium', 'webkit'] as const) {
  test(`header waiting indicator fits desktop and phone controls in ${engine}`, async ({ page }) => {
    const f = await fixture();
    const browser = engine === 'webkit' ? await webkit.launch(webkitOptions()) : undefined;
    const target = browser ? await browser.newPage() : page;
    try {
      await claudeSession(f, 'waiting');
      await target.addInitScript(() => {
        const state = { status: 'unconfigured' as const, source: '', revision: 'fixture', bundled: true, message: '' };
        const getState = async () => state;
        window.emachineInterface = { getState, setSource: getState, check: getState, refresh: getState, restore: getState, ready: getState, onState: () => () => {} };
      });
      await target.goto(f.origin);
      const waiting = target.locator('.tab-header .waiting-projects');
      await expect(waiting).toHaveText('Waiting (1)');
      await target.evaluate(() => document.fonts.ready);
      for (const width of [1360, 720, 701, 700, 390, 320]) {
        await target.setViewportSize({ width, height: 900 });
        for (const theme of ['light', 'dark']) {
          if (await target.locator('html').getAttribute('data-theme') !== theme) await target.getByRole('button', { name: /^Theme:/ }).click();
          await expect(target.locator('html')).toHaveAttribute('data-theme', theme);
          for (const control of await target.locator('.header-actions button:visible').all()) {
            await expect(control).toBeInViewport({ ratio: 1 });
            expect(await control.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
          }
          expect((await target.locator('.tabs').boundingBox())!.width).toBeGreaterThan(40);
          if (width <= 700) expect((await waiting.boundingBox())!.height).toBeGreaterThanOrEqual(44);
          expect(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          if (width === 1360 || width === 320) await target.screenshot({ path: `test-results/header-waiting-${engine}-${width}-${theme}.png`, animations: 'disabled' });
        }
      }
      await target.setViewportSize({ width: 1360, height: 900 });
      await target.getByRole('button', { name: 'Collapse project sidebar', exact: true }).click();
      await target.screenshot({ path: `test-results/header-waiting-${engine}-collapsed.png`, animations: 'disabled' });
      await target.setViewportSize({ width: 320, height: 700 });
      await waiting.click();
      await expect(target.locator('.app')).toHaveClass(/drawer-open/);
      await expect(target.locator('[data-claude-status="waiting"]')).toBeFocused();
      await expect(target.locator('[data-claude-status="waiting"]')).toBeInViewport({ ratio: 1 });
      expect(await target.evaluate(() => localStorage.getItem('emachine:sidebar-collapsed'))).toBe('true');
      await target.getByRole('button', { name: 'Close projects', exact: true }).click();
      await target.setViewportSize({ width: 1360, height: 900 });
      await expect(target.locator('#project-sidebar')).toBeHidden();
    } finally { await browser?.close(); await f.close(); }
  });
}
