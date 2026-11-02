import { test, expect, type Page } from '@playwright/test';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Terminal } from '@xterm/xterm';
// @ts-expect-error This JavaScript fixture drives the real native server.
import { fixture, socket, until } from './network-helper.mjs';

const exec = promisify(execFile);
const beginSync = '\u001b[?2026h';
const endSync = '\u001b[?2026l';
const finalMarker = 'FINAL_SCREEN_MARKER';
const historyText = 'caf\u00e9 e\u0301 \u6f22\u5b57 \ud83d\ude80';
let machine: any;
let manual: ReturnType<typeof spawn> | undefined;
let snapshot: Buffer;
let originalHistory: string;
let originalPid: string;

declare global {
  interface Window {
    attachProbe: { terminal: Terminal; parsed: number; frames: string[]; visibleFrames: string[]; copied: string[] };
    captureAttachTerminal(terminal: Terminal): void;
  }
}

const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const occurrences = (bytes: Buffer, value: string) => bytes.toString('utf8').split(value).length - 1;

async function sessionHistory() {
  return (await exec('/usr/bin/zmx', ['history', 'alpha'], { env: machine.env, timeout: 5000, maxBuffer: 8 * 1024 * 1024 })).stdout;
}

async function sessionPid() {
  const { stdout } = await exec('/usr/bin/zmx', ['list'], { env: machine.env, timeout: 5000 });
  const match = stdout.match(/name=alpha\tpid=(\d+)\t/);
  if (!match) throw new Error('The fixture manual session is missing.');
  return match[1];
}

test.beforeAll(async () => {
  machine = await fixture();
  const program = join(machine.home, 'attach-history.py');
  await writeFile(program, [
    'import sys, time',
    'for i in range(10000):',
    "    sys.stdout.write('\\x1b[36mOLD_%05d ' % i + " + JSON.stringify(historyText + ' ' + 'x'.repeat(48)) + " + '\\x1b[0m\\r\\n')",
    "sys.stdout.write('\\x1b[?1h\\x1b[?2004h\\x1b[?25l\\x1b[30;1HFINAL_SCREEN_MARKER\\x1b[30;22H')",
    'sys.stdout.flush()',
    'while True: time.sleep(1)',
    '',
  ].join('\n'));
  const env = { ...machine.env, PATH: process.env.PATH, TERM: 'xterm-256color' };
  delete env.ZMX_NO_DETACH_KEY;
  manual = spawn('script', ['--quiet', '--return', '--command',
    'stty cols 100 rows 30; exec /usr/bin/zmx attach alpha python3 -u ' + shellQuote(program), '/dev/null'], {
    cwd: machine.home, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let text = '';
  manual.stdout!.on('data', data => { text = (text + data.toString()).slice(-65536); });
  manual.stderr!.on('data', data => { text = (text + data.toString()).slice(-65536); });
  await until(() => text.includes(finalMarker));
  originalHistory = await sessionHistory();
  expect(originalHistory).toContain('OLD_00000 ' + historyText);
  originalPid = await sessionPid();
  const project = (await machine.state()).projects.find((value: { name: string }) => value.name === 'alpha');
  const client = await socket(machine, `api/v1/terminal/${project.id}?cols=100&rows=30`);
  const parts: Buffer[] = [];
  let lastOutput = Date.now(), length = 0;
  client.ws.on('message', (data: Buffer, binary: boolean) => {
    if (!binary) return;
    parts.push(Buffer.from(data)); length += data.length; lastOutput = Date.now();
  });
  try {
    await until(() => client.text.includes(finalMarker) && Date.now() - lastOutput > 100);
    expect(length).toBeGreaterThan(4096);
    snapshot = Buffer.concat(parts);
    expect(snapshot.includes(Buffer.from(finalMarker))).toBe(true);
  } finally { await client.close(); }
});

test.afterAll(async () => {
  if (manual && manual.exitCode === null && manual.signalCode === null) {
    const done = new Promise<void>(resolve => manual!.once('close', () => resolve()));
    manual.stdin!.end('\u001c');
    const timer = setTimeout(() => manual?.kill('SIGTERM'), 2000);
    await done; clearTimeout(timer);
  }
  await machine?.close();
});

async function instrument(page: Page) {
  await page.addInitScript(() => {
    window.captureAttachTerminal = terminal => {
      const probe = window.attachProbe = { terminal, parsed: 0, frames: [] as string[], visibleFrames: [] as string[], copied: [] as string[] };
      terminal.onWriteParsed(() => { probe.parsed++; });
      terminal.onRender(() => {
        const rows = terminal.element?.querySelector('.xterm-rows')?.textContent ?? '';
        if (probe.frames.length < 100) probe.frames.push(rows);
        if (terminal.element?.isConnected && getComputedStyle(terminal.element).opacity !== '0' && probe.visibleFrames.length < 100) probe.visibleFrames.push(rows);
      });
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async (text: string) => { probe.copied.push(text); },
      } });
    };
  });
  await page.route('**/assets/*.js', async route => {
    const response = await route.fetch();
    let body = await response.text();
    if (body.includes('this.output=new')) {
      expect(body.split('this.output=new').length - 1).toBe(1);
      // Expose the real terminal in this test response only; production has no test hook.
      body = body.replace('this.output=new', 'window.captureAttachTerminal(this.terminal),this.output=new');
    }
    await route.fulfill({ response, body });
  });
}

for (const size of [
  { name: 'larger viewport', viewport: { width: 1360, height: 900 }, larger: true },
  { name: 'smaller viewport', viewport: { width: 900, height: 560 }, larger: false },
]) {
  test(`cold stock-zmx attachment keeps all native history, Unicode, cursor and modes (${size.name})`, async ({ page }) => {
    await page.setViewportSize(size.viewport);
    expect(occurrences(snapshot, beginSync), 'The initial large restore must begin one synchronized update.').toBe(1);
    expect(occurrences(snapshot, endSync), 'The initial large restore must finish its synchronized update.').toBe(1);
    expect(snapshot.indexOf(beginSync)).toBeLessThan(snapshot.indexOf('OLD_00000'));
    expect(snapshot.lastIndexOf(endSync)).toBeGreaterThan(snapshot.indexOf(finalMarker));
    await instrument(page);
    const connecting = page.waitForEvent('websocket', socket => socket.url().includes('/api/v1/terminal/'));
    await page.goto(machine.origin);
    const requested = new URL((await connecting).url()).searchParams;
    for (const [dimension, manualSize] of [['cols', 100], ['rows', 30]] as const) {
      if (size.larger) expect(Number(requested.get(dimension))).toBeGreaterThan(manualSize);
      else expect(Number(requested.get(dimension))).toBeLessThan(manualSize);
    }
    await expect(page.locator('.xterm-rows')).toContainText(finalMarker);
    await expect.poll(() => page.evaluate(() => [window.attachProbe.terminal.cols, window.attachProbe.terminal.rows])).toEqual([100, 30]);
    const state = await page.evaluate(() => {
      const terminal = window.attachProbe.terminal, buffer = terminal.buffer.active;
      const firstCell = buffer.getLine(0)?.getCell(0);
      return {
        oldest: buffer.getLine(0)?.translateToString(true),
        oldestForeground: { palette: firstCell?.isFgPalette(), color: firstCell?.getFgColor() },
        historyIds: Array.from({ length: terminal.buffer.normal.length }, (_, row) => terminal.buffer.normal.getLine(row)?.translateToString(true) ?? '')
          .flatMap(line => Array.from(line.matchAll(/OLD_(\d{5})/g), match => Number(match[1]))),
        type: buffer.type, cursor: [buffer.cursorX, buffer.cursorY],
        applicationCursorKeys: terminal.modes.applicationCursorKeysMode,
        bracketedPaste: terminal.modes.bracketedPasteMode,
        synchronizedOutput: terminal.modes.synchronizedOutputMode,
      };
    });
    expect(state.oldest).toContain('OLD_00000 ' + historyText);
    expect(state.oldestForeground).toEqual({ palette: true, color: 6 });
    const expectedIds = Array.from(originalHistory.matchAll(/OLD_(\d{5})/g), match => Number(match[1]));
    expect(expectedIds).toHaveLength(10000);
    expect(state.historyIds, 'Every daemon history row must survive the scrollback-to-screen boundary in order.').toEqual(expectedIds);
    expect(state.type).toBe('normal');
    expect(state.cursor).toEqual([21, 29]);
    expect(state.applicationCursorKeys).toBe(true);
    expect(state.bracketedPaste).toBe(true);
    expect(state.synchronizedOutput).toBe(false);
    await page.evaluate(() => window.attachProbe.terminal.scrollToTop());
    await expect(page.locator('.xterm-rows > div').first()).toContainText('OLD_00000 ' + historyText);
    await page.evaluate(() => window.attachProbe.terminal.selectAll());
    await page.locator('.terminal-pane:not([hidden])').getByRole('button', { name: 'Copy', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.attachProbe.copied.length)).toBe(1);
    const copied = await page.evaluate(() => window.attachProbe.copied[0]);
    expect(copied).toContain('OLD_00000 ' + historyText);
    expect(copied).toContain('OLD_05000 ' + historyText);
    expect(copied).toContain(finalMarker);
    expect(await sessionHistory()).toBe(originalHistory);
    expect(await sessionPid()).toBe(originalPid);
  });
}

test('a split restore hides partial history until the current screen is complete', async ({ page }) => {
  await instrument(page);
  let deliver!: (data: Buffer | string) => void;
  await page.routeWebSocket(/\/api\/v1\/terminal\//, socket => {
    deliver = data => socket.send(data);
    socket.onMessage(() => {});
    socket.send(JSON.stringify({ type: 'state', mode: 'observe', session: 'alpha', cols: 100, rows: 30 }));
  });
  await page.goto(machine.origin);
  await expect(page.locator('.terminal-pane')).toHaveAttribute('data-mode', 'observe');
  // Deliver only an initial part of the real stock-daemon snapshot, then let the renderer run.
  const split = 8193; // A byte boundary need not coincide with a UTF-8 code point or VT sequence.
  const before = await page.evaluate(() => window.attachProbe.parsed);
  deliver(snapshot.subarray(0, split));
  try {
    await expect.poll(() => page.evaluate(() => window.attachProbe.parsed)).toBeGreaterThan(before);
    expect(await page.evaluate(() => window.attachProbe.terminal.modes.synchronizedOutputMode)).toBe(true);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await page.evaluate(() => window.attachProbe.frames.filter(frame => frame.includes('OLD_')))).toEqual([]);
  } finally { deliver(snapshot.subarray(split)); }
  await expect(page.locator('.xterm-rows')).toContainText(finalMarker);
  expect(await page.evaluate(() => window.attachProbe.terminal.modes.synchronizedOutputMode)).toBe(false);
  expect(await page.evaluate(() => window.attachProbe.terminal.buffer.active.getLine(0)?.translateToString(true))).toContain('OLD_00000 ' + historyText);
  expect(await sessionHistory()).toBe(originalHistory);
});

test('a restore remains visually held after the synchronization watchdog expires', async ({ page }) => {
  await instrument(page);
  let deliver!: (data: Buffer | string) => void;
  await page.routeWebSocket(/\/api\/v1\/terminal\//, socket => {
    deliver = data => socket.send(data);
    socket.onMessage(() => {});
    socket.send(JSON.stringify({ type: 'state', mode: 'observe', session: 'alpha', cols: 100, rows: 30 }));
  });
  await page.goto(machine.origin);
  await expect(page.locator('.terminal-pane')).toHaveAttribute('data-mode', 'observe');
  await page.evaluate(() => window.attachProbe.terminal.focus());
  const textarea = page.locator('.xterm-helper-textarea');
  await expect(textarea).toBeFocused();
  const before = await page.evaluate(() => window.attachProbe.parsed);
  const split = 8193;
  deliver(snapshot.subarray(0, split));
  try {
    await expect.poll(() => page.evaluate(() => window.attachProbe.parsed)).toBeGreaterThan(before);
    // The emulator's one-second watchdog may resume internal painting before all history arrives.
    await page.waitForTimeout(1200);
    await expect.poll(() => page.evaluate(() => window.attachProbe.terminal.modes.synchronizedOutputMode)).toBe(false);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await page.evaluate(() => getComputedStyle(window.attachProbe.terminal.element!).opacity)).toBe('0');
    await expect(page.locator('.terminal-status')).toContainText('Restoring terminal history');
    await expect(textarea).toBeFocused();
    expect(await page.evaluate(() => window.attachProbe.frames.some(frame => frame.includes('OLD_')))).toBe(true);
    expect(await page.evaluate(() => window.attachProbe.visibleFrames.filter(frame => frame.includes('OLD_')))).toEqual([]);
  } finally { deliver(snapshot.subarray(split)); }
  await expect(page.locator('.xterm')).toHaveCSS('opacity', '1');
  await expect(page.locator('.xterm-rows')).toContainText(finalMarker);
  await expect(textarea).toBeFocused();
  const restoredIds = await page.evaluate(() => {
    const buffer = window.attachProbe.terminal.buffer.normal;
    return Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)?.translateToString(true) ?? '')
      .flatMap(line => Array.from(line.matchAll(/OLD_(\d{5})/g), match => Number(match[1])));
  });
  const expectedIds = Array.from(originalHistory.matchAll(/OLD_(\d{5})/g), match => Number(match[1]));
  expect(expectedIds).toHaveLength(10000);
  expect(restoredIds).toEqual(expectedIds);
  expect(await page.evaluate(() => window.attachProbe.visibleFrames.filter(frame => frame.includes('OLD_') && !frame.includes('FINAL_SCREEN_MARKER')))).toEqual([]);
  expect(await sessionHistory()).toBe(originalHistory);
  expect(await sessionPid()).toBe(originalPid);
});
