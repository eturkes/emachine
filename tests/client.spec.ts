import { test, expect } from '@playwright/test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { baseUrl, endpoint, socketUrl } from '../web/transport';
// @ts-expect-error This JavaScript fixture drives the real native server.
import { fixture, socket } from './network-helper.mjs';

let a: any;
let b: any;
test.beforeAll(async () => {
  a = await fixture({ name: 'Workstation A' });
  b = await fixture({ name: 'Workstation B', origins: [a.origin] });
});
test.afterAll(async () => { await b?.close(); await a?.close(); });

test('reloading restores the selected project on a nonfirst machine', async ({ page }) => {
  await page.goto(a.origin);
  await expect(page.getByRole('button', { name: 'alpha on Workstation A, online', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Machine settings', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Remote B');
  await page.getByLabel('Direct address', { exact: true }).fill(b.origin + '/');
  await page.getByRole('button', { name: 'Connect machine', exact: true }).click();
  await page.getByRole('button', { name: 'beta on Workstation B, online', exact: true }).click();
  await expect(page.locator('.project-title')).toHaveText('beta');
  const selection = await page.evaluate(() => localStorage.getItem('emachine:selection'));
  await page.reload();
  await expect(page.getByRole('button', { name: 'beta on Workstation B, online', exact: true })).toHaveAttribute('aria-current', 'page');
  expect(await page.evaluate(() => localStorage.getItem('emachine:selection'))).toBe(selection);
});

test('app update controls stay absent even with a legacy desktop bridge', async ({ page }) => {
  await page.addInitScript(() => {
    const calls: string[] = [];
    (window as any).updateFixture = { calls };
    (window as any).emachineUpdates = Object.fromEntries(['getState', 'onState', 'check', 'download', 'install'].map(name =>
      [name, () => { calls.push(name); throw new Error('The retired app updater must not be called.'); }]));
  });
  await page.goto(a.origin);
  await expect(page.locator('.terminal-pane')).toHaveAttribute('data-mode', 'control');
  await expect(page.getByRole('button', { name: 'App updates', exact: true, includeHidden: true })).toHaveCount(0);
  await expect(page.locator('.tab-header')).not.toContainText('Updates');
  expect(await page.evaluate(() => (window as any).updateFixture.calls)).toEqual([]);
});

test('machine URLs preserve gateway prefixes and reject encoded escapes', async () => {
  const base = baseUrl('https://example.invalid/emachine/m/instance');
  expect(endpoint(base, 'api/v1/state')).toBe('https://example.invalid/emachine/m/instance/api/v1/state');
  expect(socketUrl(base, 'api/v1/events')).toBe('wss://example.invalid/emachine/m/instance/api/v1/events');
  expect(endpoint(base, 'features/file..name.js')).toBe('https://example.invalid/emachine/m/instance/features/file..name.js');
  for (const path of ['../escape', '%2e%2e/escape', '\\\\outside.invalid/path', '/api/v1/state', '\thttps://outside.invalid/']) {
    expect(() => endpoint(base, path)).toThrow();
  }
});

test('live discovery, concurrent machines and persistent terminal rendering', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(a.origin);
  await expect(page.getByRole('button', { name: 'App updates', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'alpha on Workstation A, online', exact: true })).toBeVisible();
  await expect(page.locator('.terminal-pane')).toHaveCount(1);
  await expect(page.locator('.terminal-pane')).toHaveAttribute('data-mode', 'control');
  const alpha = (await a.state()).projects.find((project: any) => project.name === 'alpha');
  const observer = await socket(a, `api/v1/terminal/${alpha.id}`);
  try {
    await page.locator('.terminal-pane .xterm-helper-textarea').focus();
    await page.keyboard.type("printf '__GUI''_INPUT__\\n'");
    await page.keyboard.press('Enter');
    await expect.poll(() => observer.text.includes('__GUI_INPUT__')).toBe(true);
  } finally { await observer.close(); }
  await page.locator('.terminal-pane').evaluate(element => { (element as HTMLElement).dataset.continuity = 'kept'; });
  await mkdir(join(a.config.projectRoot, 'browser-added'));
  await expect(page.getByRole('button', { name: 'browser-added on Workstation A, online', exact: true })).toBeVisible();
  await rm(join(a.config.projectRoot, 'browser-added'), { recursive: true });
  await expect(page.getByRole('button', { name: 'browser-added on Workstation A, online', exact: true })).toHaveCount(0);
  await expect(page.locator('.terminal-pane')).toHaveAttribute('data-continuity', 'kept');
  await page.getByRole('button', { name: 'Machine settings', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Remote B');
  await page.getByLabel('Direct address', { exact: true }).fill(b.origin + '/');
  await page.getByRole('button', { name: 'Connect machine', exact: true }).click();
  await expect(page.getByRole('button', { name: 'alpha on Workstation B, online', exact: true })).toBeVisible();
  await expect(page.locator('.machine-count')).toHaveText('2 of 2 machines online');
  await page.screenshot({ path: 'test-results/emachine-desktop.png', animations: 'disabled' });
  expect(errors).toEqual([]);
});

test('workspace switcher uses text and preserves navigation', async ({ page }) => {
  await page.goto(a.origin);
  await expect(page.locator('.terminal-pane')).toHaveAttribute('data-mode', 'control');
  const label = 'Go to a workspace or view, Control Shift P';
  const switcher = page.getByRole('button', { name: label, exact: true, includeHidden: true });
  expect(await switcher.count()).toBe(1);
  await expect(switcher).toHaveText('Workspaces');
  await expect(switcher).toHaveAttribute('title', label);
  await switcher.click();
  const search = page.getByRole('textbox', { name: 'Search commands', exact: true });
  await expect(search).toBeFocused();
  await search.fill('beta');
  await page.getByRole('button', { name: 'beta / Terminal · Workstation A', exact: true }).click();
  await expect(page.locator('.project-title')).toHaveText('beta');
  await switcher.focus();
  await page.keyboard.press('Control+Shift+P');
  await expect(search).toBeFocused();
  await search.fill('alpha');
  await page.keyboard.press('Enter');
  await expect(page.locator('.project-title')).toHaveText('alpha');
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/emachine-workspace-switcher.png', animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(switcher).toBeVisible();
  await switcher.click();
  await expect(search).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('top bar uses text controls without connection badges at desktop and phone widths', async ({ page }) => {
  await page.addInitScript(() => {
    const state = { status: 'unconfigured' as const, source: '', revision: 'fixture', bundled: true, message: 'Choose an interface source.' };
    const getState = async () => state;
    window.emachineInterface = { getState, setSource: getState, check: getState, refresh: getState, restore: getState, ready: getState, onState: () => () => {} };
  });
  await page.goto(a.origin);
  await expect(page.locator('.terminal-pane')).toHaveAttribute('data-mode', 'control');
  const header = page.locator('.tab-header');
  await expect(header.getByRole('tab')).toHaveText('Terminal');
  await expect(header.locator('.connection-badge')).toHaveCount(0);
  await expect(header).not.toContainText(/Direct|Gateway|Offline/);
  const settings = header.getByRole('button', { name: 'Machine settings', exact: true });
  const theme = header.getByRole('button', { name: /^Theme:/ });
  await expect(settings).toHaveText('Settings');
  await expect(theme).toHaveText('Theme');
  await expect(header.getByRole('button', { name: 'Interface updates', exact: true })).toHaveText('Refresh');
  for (const width of [1360, 720, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const control of await header.locator('button:visible').all()) {
      await expect(control).toBeInViewport({ ratio: 1 });
      expect(await control.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      expect((await control.innerText()).trim()).toMatch(/^[A-Za-z ]+$/);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await settings.click();
    await expect(page.getByRole('heading', { name: 'Machines', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    for (const value of ['dark', 'light', 'auto']) {
      await theme.click();
      await expect(theme).toHaveAttribute('aria-label', new RegExp(`^Theme: ${value}`));
      if (value !== 'auto') await page.screenshot({ path: `test-results/emachine-text-header-${width}-${value}.png`, animations: 'disabled' });
    }
    if (width <= 700) {
      const projects = header.getByRole('button', { name: 'Open project drawer', exact: true });
      await expect(projects).toHaveText('Projects');
      await projects.click();
      await expect(page.getByRole('button', { name: 'Close projects', exact: true })).toHaveText('Close');
      await page.getByRole('button', { name: 'Close projects', exact: true }).click();
    }
  }
});

for (const viewport of [{ width: 1360, height: 900 }, { width: 390, height: 844 }]) {
  test(`terminal uses standard-width monospace at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto(a.origin);
    await expect(page.locator('.terminal-pane')).toHaveAttribute('data-mode', 'control');
    const metrics = await page.locator('.xterm-rows').evaluate(async element => {
      const style = getComputedStyle(element);
      await document.fonts.load(`${style.fontSize} ${style.fontFamily}`);
      const canvas = document.createElement('canvas').getContext('2d')!;
      canvas.font = `${style.fontSize} ${style.fontFamily}`;
      return {
        family: style.fontFamily, size: parseFloat(style.fontSize),
        widths: [...'MWil01@#'].map(character => canvas.measureText(character).width),
      };
    });
    expect(metrics.size).toBe(14);
    // Check real glyph metrics, not just the configured family or a fallback face.
    for (const width of metrics.widths) {
      expect(width / metrics.size).toBeGreaterThanOrEqual(.58);
      expect(width / metrics.size).toBeLessThanOrEqual(.64);
      expect(width).toBeCloseTo(metrics.widths[0], 3);
    }
    expect(metrics.family.split(',')[0].replaceAll('"', '').trim()).toBe('JetBrains Mono');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/emachine-terminal-${viewport.width}.png`, animations: 'disabled' });
  });
}

test('terminal cells match the loaded font after a delayed font response', async ({ page }) => {
  await page.route(/jetbrains-mono.*\.woff2$/, async route => {
    await new Promise(resolve => setTimeout(resolve, 500));
    await route.continue();
  });
  await page.goto(a.origin);
  const textRun = page.locator('.xterm-rows span').filter({ hasText: /\S/ }).first();
  await expect(textRun).toBeVisible();
  const metrics = await textRun.evaluate(async element => {
    await document.fonts.ready;
    const style = getComputedStyle(element);
    const canvas = document.createElement('canvas').getContext('2d')!;
    canvas.font = `${style.fontSize} ${style.fontFamily}`;
    const text = element.textContent!;
    return {
      cell: element.getBoundingClientRect().width / text.length,
      glyph: canvas.measureText(text).width / text.length,
      pixel: 1 / devicePixelRatio,
    };
  });
  expect(Math.abs(metrics.cell - metrics.glyph)).toBeLessThanOrEqual(metrics.pixel);
});

test('light palette stays neutral across the shell, terminal and phone layout', async ({ page }) => {
  await page.goto(a.origin);
  await expect(page.locator('.terminal-pane')).toHaveAttribute('data-mode', 'control');
  const toggle = page.getByRole('button', { name: /^Theme:/ });
  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const colors = () => page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const tokens = Object.fromEntries(['bg', 'surface', 'raised', 'hover', 'text', 'muted', 'border', 'accent', 'accent-soft'].map(name => [name, root.getPropertyValue('--' + name).trim()]));
    return {
      tokens,
      selection: getComputedStyle(document.documentElement, '::selection').backgroundColor,
      terminalText: getComputedStyle(document.querySelector('.xterm-rows')!).color,
      terminalBackground: getComputedStyle(document.querySelector('.xterm-scrollable-element')!).backgroundColor,
      chrome: document.querySelector('meta[name="theme-color"]')!.getAttribute('content'),
    };
  });
  const dark = await colors();
  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const rgb = (color: string) => color.startsWith('#') ? color.slice(1, 7).match(/../g)!.map(hex => parseInt(hex, 16)) : color.match(/[\d.]+/g)!.slice(0, 3).map(Number);
  const luminance = (color: string) => rgb(color).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  const light = await colors();
  for (const [name, color] of Object.entries({ ...light.tokens, selection: light.selection, terminalText: light.terminalText, terminalBackground: light.terminalBackground })) {
    expect(new Set(rgb(color)).size, `${name} must have no color tint`).toBe(1);
  }
  expect(rgb(light.terminalText)).toEqual(rgb(light.tokens.text));
  expect(rgb(light.terminalBackground)).toEqual(rgb(light.tokens.bg));
  expect(light.chrome).toBe(light.tokens.bg);
  for (const foreground of ['text', 'muted', 'accent']) for (const background of ['bg', 'surface', 'hover']) {
    const values = [luminance(light.tokens[foreground]), luminance(light.tokens[background])].sort((a, b) => a - b);
    expect((values[1] + .05) / (values[0] + .05), `${foreground} contrast on ${background}`).toBeGreaterThanOrEqual(4.5);
  }
  await page.screenshot({ path: 'test-results/emachine-light-desktop.png', animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.terminal-keys')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/emachine-light-phone.png', animations: 'disabled' });
  await page.getByRole('button', { name: 'Open project drawer', exact: true }).click();
  await expect(page.getByRole('button', { name: 'alpha on Workstation A, online', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/emachine-light-drawer.png', animations: 'disabled' });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('.terminal-pane')).toHaveAttribute('data-mode', 'control');
  expect(await colors()).toEqual(light);
  await toggle.click(); await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await colors()).toEqual(dark);
});

test('feature replacement updates only its project view', async ({ page }) => {
  await page.goto(a.origin);
  await expect(page.locator('.terminal-pane')).toHaveAttribute('data-mode', 'control');
  await page.locator('.terminal-pane').evaluate(element => { (element as HTMLElement).dataset.continuity = 'kept'; });
  const workspace = JSON.parse(await a.cli('feature', 'create', 'alpha', 'browser-view', 'Browser view')).workspace;
  await writeFile(join(workspace, 'index.html'), '<!doctype html><title>View</title><p>First live revision</p>');
  await a.cli('feature', 'activate', 'alpha', 'browser-view');
  await page.getByRole('tab', { name: 'Browser view', exact: true }).click();
  const frame = page.frameLocator('iframe[title="Browser view — alpha"]');
  await expect(frame.locator('body')).toContainText('First live revision');
  await writeFile(join(workspace, 'index.html'), '<!doctype html><title>View</title><p>Second live revision</p>');
  await a.cli('feature', 'activate', 'alpha', 'browser-view');
  await expect(frame.locator('body')).toContainText('Second live revision');
  await expect(page.locator('.terminal-pane')).toHaveAttribute('data-continuity', 'kept');
  await a.cli('feature', 'remove', 'alpha', 'browser-view');
  await expect(page.getByRole('tab', { name: 'Browser view', exact: true })).toHaveCount(0);
  await expect(page.locator('.feature-frame')).toHaveCount(0);
  await expect(page.locator('.terminal-pane')).toHaveAttribute('data-continuity', 'kept');
});

test('phone drawer, touch controls and shell-only offline cache', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(a.origin);
  await expect(page.locator('.terminal-pane')).toHaveAttribute('data-mode', 'control');
  await page.getByRole('button', { name: 'Open project drawer', exact: true }).click();
  await page.getByRole('button', { name: 'beta on Workstation A, online', exact: true }).click();
  await expect(page.locator('.project-title')).toHaveText('beta');
  await expect(page.locator('.terminal-pane:not([hidden]) .terminal-keys')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/emachine-phone.png', animations: 'disabled' });
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  const cached = await page.evaluate(async () => {
    const paths: string[] = [];
    for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) paths.push(request.url);
    return paths;
  });
  expect(cached.some(url => url.endsWith('/index.html'))).toBe(true);
  expect(cached.some(url => url.includes('/api/') || url.includes('bootstrap.json'))).toBe(false);
  await context.setOffline(true); await page.reload();
  await expect(page.locator('.brand-name')).toHaveText('emachine');
  await expect(page.locator('.machine-count')).toHaveText('0 of 1 machines online');
  await context.setOffline(false);
});

test('fallback route, identity deduplication and reconnection preserve project state', async ({ page }) => {
  await page.goto(a.origin);
  await expect(page.locator('.terminal-pane')).toHaveAttribute('data-mode', 'control');
  async function connect(name: string, direct: string, gateway = '') {
    await page.getByRole('button', { name: 'Machine settings', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill(name);
    await page.getByLabel('Direct address', { exact: true }).fill(direct);
    await page.getByLabel('Gateway address (optional)', { exact: true }).fill(gateway);
    await page.getByRole('button', { name: 'Connect machine', exact: true }).click();
  }
  await connect('Fallback B', 'http://127.0.0.1:9/', b.origin + '/');
  const row = page.getByRole('button', { name: 'alpha on Workstation B, online', exact: true });
  await row.click();
  await page.getByRole('button', { name: 'Machine settings', exact: true }).click();
  await expect(page.locator('.connection-row').filter({ hasText: 'Fallback B' }).locator('.online-text')).toHaveText(`Connected through ${b.origin}/`);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(page.locator('.terminal-pane:not([hidden])')).toHaveAttribute('data-mode', 'control');
  await page.locator('.terminal-pane:not([hidden])').evaluate(element => { (element as HTMLElement).dataset.continuity = 'retained'; });
  await connect('Same machine direct', b.origin + '/');
  await expect(page.locator('.machine-count')).toHaveText('2 of 2 machines online');
  await expect(row).toHaveCount(1);
  await b.stop();
  await expect(page.locator('.offline-banner')).toBeVisible();
  await expect(page.getByRole('button', { name: 'alpha on Workstation B, offline', exact: true })).toHaveCount(1);
  await expect(page.locator('.terminal-pane:not([hidden])')).toHaveAttribute('data-mode', 'disconnected');
  await page.locator('.terminal-pane:not([hidden]) .xterm-helper-textarea').focus();
  await page.keyboard.type('EMACHINE_OFFLINE_INPUT=must_not_replay'); await page.keyboard.press('Enter');
  await b.start();
  await expect(page.locator('.terminal-pane:not([hidden])')).toHaveAttribute('data-mode', 'control');
  await expect(page.locator('.terminal-pane:not([hidden])')).toHaveAttribute('data-continuity', 'retained');
  const alpha = (await b.state()).projects.find((project: any) => project.name === 'alpha');
  const observer = await socket(b, `api/v1/terminal/${alpha.id}`);
  try {
    await page.locator('.terminal-pane:not([hidden]) .xterm-helper-textarea').focus();
    await page.keyboard.type("printf '__OFFLINE''_VALUE__%s__END__\\n' \"$EMACHINE_OFFLINE_INPUT\""); await page.keyboard.press('Enter');
    await expect.poll(() => observer.text.includes('__OFFLINE_VALUE____END__')).toBe(true);
  } finally { await observer.close(); }
});

test('reopening the client recovers completed server-owned jobs', async ({ page }) => {
  const workspace = JSON.parse(await a.cli('feature', 'create', 'alpha', 'job-history', 'Job history')).workspace;
  await writeFile(join(workspace, 'feature.json'), JSON.stringify({ id: 'job-history', title: 'Job history', actions: { inspect: ['/bin/true'] } }));
  await a.cli('feature', 'activate', 'alpha', 'job-history');
  const alpha = (await a.state()).projects.find((project: any) => project.name === 'alpha');
  const response = await a.request(`api/v1/projects/${alpha.id}/features/job-history/jobs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'inspect', input: null }),
  });
  expect(response.status).toBe(202);
  const job = await response.json();
  await expect.poll(async () => (await (await a.request(`api/v1/jobs/${job.id}`)).json()).status).toBe('succeeded');
  await page.goto(a.origin);
  await page.getByRole('button', { name: 'Jobs', exact: true }).click();
  await expect(page.locator('.job-row').filter({ hasText: 'job-history / inspect' })).toContainText('succeeded');
  await a.cli('feature', 'remove', 'alpha', 'job-history');
});
