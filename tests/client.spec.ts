import { test, expect } from '@playwright/test';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { baseUrl, endpoint, socketUrl } from '../web/transport';
// @ts-expect-error This JavaScript fixture drives the real native server.
import { fixture, socket } from './network-helper.mjs';
// @ts-expect-error Shared JavaScript color assertions also run in project-owned feature gates.
import { neutral, neutralTheme } from './theme-contract.mjs';

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
  await expect(page.getByRole('button', { name: 'beta on Workstation B, online', exact: true })).toHaveAttribute('aria-current', 'page');
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

test('workspace search stays keyboard-accessible without a header button', async ({ page }) => {
  await page.goto(a.origin);
  await expect(page.locator('.terminal-pane')).toHaveAttribute('data-mode', 'control');
  await expect(page.getByRole('button', { name: 'Go to a workspace or view, Control Shift P', exact: true, includeHidden: true })).toHaveCount(0);
  await page.keyboard.press('Control+Shift+P');
  const search = page.getByRole('textbox', { name: 'Search commands', exact: true });
  await expect(search).toBeFocused();
  await search.fill('beta');
  await page.getByRole('button', { name: 'beta / Terminal · Workstation A', exact: true }).click();
  await expect(page.getByRole('button', { name: 'beta on Workstation A, online', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('button', { name: 'Machine settings', exact: true }).focus();
  await page.keyboard.press('Control+Shift+P');
  await expect(search).toBeFocused();
  await search.fill('alpha');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'alpha on Workstation A, online', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/emachine-workspace-switcher.png', animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press('Control+Shift+P');
  await expect(search).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('top bar uses text controls without connection badges at desktop and phone widths', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
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
  await expect(theme).toHaveText('Light');
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
    for (const value of ['dark', 'light']) {
      await theme.click();
      await expect(theme).toHaveAttribute('aria-label', new RegExp(`^Theme: ${value}`));
      await expect(theme).toHaveText(value === 'dark' ? 'Dark' : 'Light');
      await page.screenshot({ path: `test-results/emachine-text-header-${width}-${value}.png`, animations: 'disabled' });
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

for (const environment of ['light', 'dark'] as const) {
  test(`theme resolves once from ${environment} and persists only explicit colors`, async ({ page }) => {
    const opposite = environment === 'dark' ? 'light' : 'dark';
    // ChromiumFish fixes this media query to light; simulate the environment, including change events.
    await page.addInitScript(initial => {
      let scheme = sessionStorage.getItem('test:color-scheme') ?? initial;
      const matchMedia = window.matchMedia.bind(window);
      const queries = new Map<MediaQueryList, string>();
      window.matchMedia = query => {
        const media = matchMedia(query);
        const color = /^\(prefers-color-scheme: (light|dark)\)$/.exec(query)?.[1];
        if (color) { Object.defineProperty(media, 'matches', { get: () => scheme === color }); queries.set(media, color); }
        return media;
      };
      (window as any).setTestColorScheme = (value: string) => {
        scheme = value; sessionStorage.setItem('test:color-scheme', value);
        for (const [media, color] of queries) media.dispatchEvent(new MediaQueryListEvent('change', { media: media.media, matches: value === color }));
      };
    }, environment);
    await page.goto(a.origin);
    for (const saved of [null, '"auto"', '"invalid"', 'not-json', '"light"', '"dark"']) {
      await page.evaluate(value => (window as any).setTestColorScheme(value), environment);
      await page.evaluate(value => value === null ? localStorage.removeItem('emachine:theme') : localStorage.setItem('emachine:theme', value), saved);
      await page.reload();
      const initial = saved === '"light"' ? 'light' : saved === '"dark"' ? 'dark' : environment;
      const next = initial === 'dark' ? 'light' : 'dark';
      await expect(page.locator('html')).toHaveAttribute('data-theme', initial);
      const toggle = page.getByRole('button', { name: /^Theme:/ });
      await expect(toggle).toHaveText(initial === 'dark' ? 'Dark' : 'Light');
      expect(await page.evaluate(() => localStorage.getItem('emachine:theme'))).toBe(JSON.stringify(initial));
      await page.evaluate(value => (window as any).setTestColorScheme(value), opposite);
      await expect(page.locator('html')).toHaveAttribute('data-theme', initial);
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', initial);
      await toggle.click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', next);
      await expect(toggle).toHaveText(next === 'dark' ? 'Dark' : 'Light');
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', next);
    }
  });
}

test('streamlined layout ignores old collapse state and removes decorative strips', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('emachine:collapsed', 'true'));
  await page.goto(a.origin);
  await expect(page.locator('.terminal-pane')).toHaveAttribute('data-mode', 'control');
  await expect(page.locator('.brand-mark, .empty-mark, .project-glyph, .collapse-control, .context-bar, .project-title, .project-path, .terminal-footer')).toHaveCount(0);
  await expect(page.locator('.app')).not.toHaveClass(/rail-collapsed/);
  await expect(page.getByRole('button', { name: /Jobs|Collapse or expand|Go to a workspace or view/, includeHidden: true })).toHaveCount(0);
  await expect(page.locator('.workspace')).not.toContainText('Live shell');
  for (const width of [1360, 720, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    if (width <= 700) await page.getByRole('button', { name: 'Open project drawer', exact: true }).click();
    await expect(page.locator('.brand-name')).toBeInViewport();
    await expect(page.locator('.project-copy').first()).toBeInViewport();
    if (width <= 700) await page.getByRole('button', { name: 'Close projects', exact: true }).click();
    await expect(page.locator('.terminal-keys')).toBeVisible();
    for (const key of await page.locator('.terminal-keys button:visible').all()) {
      expect(await key.evaluate(node => node.scrollWidth <= node.clientWidth), `${await key.innerText()} must fit its button at ${width}px`).toBe(true);
    }
    for (const name of ['Copy', 'Paste', 'Alt + Arrow Up']) {
      const key = page.locator('.terminal-keys').getByRole('button', { name, exact: true });
      await key.scrollIntoViewIfNeeded();
      await expect(key).toBeInViewport({ ratio: 1 });
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test('terminal shortcuts encode modifiers and retain observer control without a footer', async ({ page }) => {
  const input: string[] = [];
  let send!: (data: string | Buffer) => void;
  await page.routeWebSocket(/\/api\/v1\/terminal\//, ws => {
    send = data => ws.send(data);
    ws.onMessage(data => {
      if (Buffer.isBuffer(data)) input.push(data.toString('hex'));
      else if (JSON.parse(data).type === 'claim') send(JSON.stringify({ type: 'state', mode: 'control', session: 'fixture', cols: 80, rows: 24 }));
    });
    send(JSON.stringify({ type: 'state', mode: 'control', session: 'fixture', cols: 80, rows: 24 }));
    send(Buffer.from('Shortcut fixture\r\n'));
  });
  await page.goto(a.origin);
  await expect(page.locator('.terminal-pane')).toHaveAttribute('data-mode', 'control');
  const keys = page.locator('.terminal-keys');
  const alt = keys.getByRole('button', { name: 'Use Alt with the next key', exact: true });
  const ctrl = keys.getByRole('button', { name: 'Use Control with the next character', exact: true });
  const received = async (value: string) => { await expect.poll(() => input.join('')).toBe(Buffer.from(value).toString('hex')); input.length = 0; };
  await alt.click(); await expect(alt).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.type('b'); await received('\u001bb');
  await expect(alt).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.type('b'); await received('b');
  await alt.click(); await page.keyboard.insertText('é'); await received('\u001bé');
  await ctrl.click(); await alt.click(); await page.keyboard.type('c'); await received('\u001b\u0003');
  await expect(ctrl).toHaveAttribute('aria-pressed', 'false');
  await ctrl.click(); await page.keyboard.type('c'); await received('\u0003');
  await alt.click(); await alt.click(); await page.keyboard.type('x'); await received('x');
  for (const application of [false, true]) {
    send(Buffer.from(application ? '\u001b[?1h' : '\u001b[?1l'));
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.press('Alt+ArrowUp'); await received('\u001b[1;3A');
    await keys.getByRole('button', { name: 'Alt + Arrow Up', exact: true }).click(); await received('\u001b[1;3A');
    await alt.click(); await keys.getByRole('button', { name: '↑', exact: true }).click(); await received('\u001b[1;3A');
    await expect(alt).toHaveAttribute('aria-pressed', 'false');
    await alt.click(); await page.keyboard.press('ArrowUp'); await received('\u001b[1;3A');
  }
  for (const [name, value] of [['Esc', '\u001b'], ['Tab', '\t'], ['↓', '\u001b[B'], ['←', '\u001b[D'], ['→', '\u001b[C'], ['Ctrl-C', '\u0003']]) {
    await keys.getByRole('button', { name, exact: true }).click(); await received(value);
  }
  send(JSON.stringify({ type: 'state', mode: 'observe', session: 'fixture', cols: 80, rows: 24 }));
  await expect(page.locator('.terminal-pane')).toHaveAttribute('data-mode', 'observe');
  await expect(keys).toContainText('Observing');
  await keys.getByRole('button', { name: 'Alt + Arrow Up', exact: true }).click();
  await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.type('dropped');
  await keys.getByRole('button', { name: 'Take control', exact: true }).click();
  await expect(page.locator('.terminal-pane')).toHaveAttribute('data-mode', 'control');
  await page.keyboard.type('retained'); await received('retained');
  await expect(keys).not.toContainText(/Observing|Live shell/);
  await expect(page.locator('.terminal-footer')).toHaveCount(0);
});

test('terminal Copy uses the selected text and reports unavailable clipboard access', async ({ page, context }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: a.origin });
  await page.routeWebSocket(/\/api\/v1\/terminal\//, ws => {
    ws.send(JSON.stringify({ type: 'state', mode: 'control', session: 'fixture', cols: 80, rows: 24 }));
    ws.send(Buffer.from('\u001b[2J\u001b[HclipboardFixture\r\n'));
  });
  await page.goto(a.origin);
  const copy = page.locator('.terminal-keys').getByRole('button', { name: 'Copy', exact: true });
  await expect(page.locator('.xterm-rows')).toContainText('clipboardFixture');
  await page.evaluate(() => navigator.clipboard.writeText('preserve this'));
  await copy.click();
  await expect(page.locator('.toast-region')).toContainText('Select terminal text to copy.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('preserve this');
  const text = page.locator('.xterm-rows span').filter({ hasText: 'clipboardFixture' }).first();
  const bounds = (await text.boundingBox())!;
  await page.mouse.dblclick(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await copy.click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('clipboardFixture');
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new DOMException('Denied', 'NotAllowedError'); }; });
  await copy.click();
  await expect(page.locator('.toast-region')).toContainText('Clipboard access was not granted.');
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
  await copy.click();
  await page.locator('.terminal-keys').getByRole('button', { name: 'Paste', exact: true }).click();
  expect(errors).toEqual([]);
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
  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await colors()).toEqual(dark);
});

test('dark structural palette stays neutral with readable controls and terminal', async ({ page }) => {
  await page.goto(a.origin);
  if (await page.locator('html').getAttribute('data-theme') !== 'dark') await page.getByRole('button', { name: /^Theme:/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.terminal-pane')).toHaveAttribute('data-mode', 'control');
  await neutralTheme(page.locator('body'), {
    tokens: ['bg', 'surface', 'raised', 'hover', 'text', 'muted', 'border', 'accent', 'accent-soft', 'selection', 'backdrop', 'scrim'],
    selectors: ['.project-item.active', '.tab.active', '.header-actions', '.terminal-keys button', '.xterm-rows', '.xterm-scrollable-element'],
    surfaces: ['bg', 'surface', 'raised', 'hover'], semantic: ['warning', 'danger'],
  });
  await page.screenshot({ path: 'test-results/emachine-neutral-dark-desktop.png', animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open project drawer', exact: true }).click();
  await page.screenshot({ path: 'test-results/emachine-neutral-dark-phone.png', animations: 'disabled' });
});

test('SDK controls and native authentication use neutral colors', async ({ page }) => {
  for (const file of ['web/public/sdk.css', 'desktop/auth.css']) {
    await page.setContent(`<style>${await readFile(file, 'utf8')}</style><p>Details</p><form><label>Address<input></label><button type="submit">Connect</button></form><a href="#">Help</a>`);
    for (const theme of ['dark', 'light']) {
      await page.locator('html').evaluate((element, theme) => { element.dataset.theme = theme; }, theme);
      await page.locator('input').focus();
      const samples = await page.locator('body').evaluate(() => [...document.querySelectorAll('html,p,input,button')].flatMap(element => {
        const style = getComputedStyle(element);
        return ['color', 'backgroundColor', 'borderTopColor', 'outlineColor'].map(property => ({ name: `${element.tagName}.${property}`, color: style[property as keyof CSSStyleDeclaration] as string }));
      }));
      for (const { name, color } of samples) neutral(color, `${file} ${theme} ${name}`);
    }
  }
});

test('launcher icons and startup colors contain no decorative tint', async () => {
  const { default: sharp } = await import('sharp');
  for (const size of [180, 192, 512]) {
    const { data, info } = await sharp(`web/public/icons/${size}.png`).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height, info.channels]).toEqual([size, size, 4]);
    let visible = 0, tinted = 0;
    for (let index = 0; index < data.length; index += 4) if (data[index + 3]) {
      visible++;
      if (data[index] !== data[index + 1] || data[index + 1] !== data[index + 2]) tinted++;
    }
    expect(visible).toBeGreaterThan(size * size / 2);
    expect(tinted, `${size}px icon tinted pixels`).toBe(0);
  }
  const manifest = JSON.parse(await readFile('web/public/manifest.webmanifest', 'utf8'));
  neutral(manifest.background_color, 'PWA background'); neutral(manifest.theme_color, 'PWA theme');
  neutral((await readFile('web/index.html', 'utf8')).match(/name="theme-color" content="([^"]+)"/)![1], 'HTML startup');
  neutral((await readFile('desktop/main.cjs', 'utf8')).match(/backgroundColor: '([^']+)'/)![1], 'Native startup');
});

test('new feature starter follows both neutral parent themes', async ({ page }) => {
  await a.cli('feature', 'create', 'alpha', 'neutral-starter', 'Neutral starter');
  await a.cli('feature', 'activate', 'alpha', 'neutral-starter');
  try {
    await page.goto(a.origin);
    await page.getByRole('tab', { name: 'Neutral starter', exact: true }).click();
    const frame = page.frameLocator('iframe[title="Neutral starter — alpha"]');
    for (const theme of ['light', 'dark']) {
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(frame.locator('html')).toHaveAttribute('data-theme', theme);
      const colors = await frame.locator('body').evaluate(() => [document.documentElement, document.querySelector('p')!].flatMap(element => {
        const style = getComputedStyle(element); return [style.color, style.backgroundColor];
      }));
      for (const color of colors) neutral(color, `starter ${theme}`);
      await page.getByRole('button', { name: /^Theme:/ }).click();
    }
  } finally { await a.cli('feature', 'remove', 'alpha', 'neutral-starter'); }
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
  await expect(page.getByRole('button', { name: 'beta on Workstation A, online', exact: true })).toHaveAttribute('aria-current', 'page');
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
  await writeFile(join(workspace, 'index.html'), '<!doctype html><p>Waiting for recovered jobs</p><script>addEventListener("message", event => { if (event.source === parent && event.data.type === "emachine:job") document.querySelector("p").textContent = event.data.job.feature + " / " + event.data.job.action + " / " + event.data.job.status; });</script>');
  await a.cli('feature', 'activate', 'alpha', 'job-history');
  const alpha = (await a.state()).projects.find((project: any) => project.name === 'alpha');
  const response = await a.request(`api/v1/projects/${alpha.id}/features/job-history/jobs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'inspect', input: null }),
  });
  expect(response.status).toBe(202);
  const job = await response.json();
  await expect.poll(async () => (await (await a.request(`api/v1/jobs/${job.id}`)).json()).status).toBe('succeeded');
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/v1/jobs', async route => { await ready; await route.continue(); });
  await page.goto(a.origin);
  await page.getByRole('tab', { name: 'Job history', exact: true }).click();
  const frame = page.frameLocator('iframe[title="Job history — alpha"]');
  await expect(frame.locator('p')).toHaveText('Waiting for recovered jobs');
  release();
  await expect(frame.locator('p')).toHaveText('job-history / inspect / succeeded');
  await expect(page.getByRole('button', { name: 'Jobs', exact: true, includeHidden: true })).toHaveCount(0);
  await a.cli('feature', 'remove', 'alpha', 'job-history');
});
