import { test, expect, type Page } from '@playwright/test';
// @ts-expect-error This JavaScript fixture drives the real native server.
import { fixture } from './network-helper.mjs';

test.use({ serviceWorkers: 'block' });

let machine: any;
test.beforeAll(async () => { machine = await fixture({ name: 'Recovery workstation' }); });
test.afterAll(async () => { await machine?.close(); });

type SocketFault = {
  connections: number;
  closeCalls: number;
  input: string[];
  readonly ready: boolean;
  stall(): void;
  release(): void;
  late(): void;
};
declare global { interface Window { recoveryFault: SocketFault } }

async function halfOpenSocket(page: Page, target: 'events' | 'terminal', holdReplacement = false) {
  await page.addInitScript(({ target, holdReplacement }) => {
    const NativeWebSocket = window.WebSocket;
    const sockets: FaultSocket[] = [];
    let holding = holdReplacement;
    let saved: { open: WebSocket['onopen']; message: WebSocket['onmessage']; close: WebSocket['onclose'] } | undefined;
    let oldInventory: any;
    const fault: SocketFault = {
      connections: 0, closeCalls: 0, input: [],
      get ready() { return sockets[0]?.readyState === NativeWebSocket.OPEN && (target !== 'events' || Boolean(oldInventory)); },
      stall() {
        const first = sockets[0];
        if (!first || first.readyState !== NativeWebSocket.OPEN) throw new Error('The fixture socket is not open.');
        saved = { open: first.onopen, message: first.onmessage, close: first.onclose };
        first.blocked = true;
        // Release the real fixture peer, but hide the close from the renderer just as a blackholed path does.
        NativeWebSocket.prototype.close.call(first);
      },
      release() {
        holding = false;
        for (const socket of sockets) {
          socket.held = false;
          for (const event of socket.pending.splice(0)) socket.dispatchEvent(event);
        }
      },
      late() {
        const first = sockets[0];
        if (!first || !saved) throw new Error('No stale socket callbacks were captured.');
        saved.open?.call(first, new Event('open'));
        const message = target === 'events'
          ? { type: 'inventory', state: { ...oldInventory, machine: { ...oldInventory.machine, name: 'Stale workstation' } } }
          : { type: 'state', mode: 'observe', session: 'stale', cols: 20, rows: 5 };
        saved.message?.call(first, new MessageEvent('message', { data: JSON.stringify(message) }));
        if (target === 'terminal') {
          saved.message?.call(first, new MessageEvent('message', { data: new TextEncoder().encode('STALE_SOCKET_OUTPUT').buffer }));
        }
        saved.close?.call(first, new CloseEvent('close'));
      },
    };
    class FaultSocket extends NativeWebSocket {
      blocked = false;
      closing = false;
      held = false;
      targeted = false;
      pending: Event[] = [];
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols ?? []);
        const path = new URL(String(url)).pathname;
        this.targeted = target === 'events' ? path.endsWith('/api/v1/events') : path.includes('/api/v1/terminal/');
        if (!this.targeted) return;
        sockets.push(this);
        fault.connections++;
        this.held = holding && sockets.length > 1;
        this.addEventListener('open', event => {
          if (this.blocked) event.stopImmediatePropagation();
          else if (this.held) { this.pending.push(new Event('open')); event.stopImmediatePropagation(); }
        }, true);
        this.addEventListener('message', event => {
          if (!this.blocked && target === 'events') {
            try { const message = JSON.parse(String(event.data)); if (message.type === 'inventory') oldInventory = message.state; } catch {}
          }
          if (this.blocked) event.stopImmediatePropagation();
          else if (this.held) { this.pending.push(new MessageEvent('message', { data: event.data })); event.stopImmediatePropagation(); }
        }, true);
        this.addEventListener('close', event => { if (this.blocked) event.stopImmediatePropagation(); }, true);
        this.addEventListener('error', event => { if (this.blocked) event.stopImmediatePropagation(); }, true);
      }
      get readyState(): WebSocket['readyState'] {
        return this.blocked ? (this.closing ? NativeWebSocket.CLOSING : NativeWebSocket.OPEN) : super.readyState;
      }
      close(code?: number, reason?: string): void {
        if (this.blocked) { this.closing = true; fault.closeCalls++; return; }
        super.close(code, reason);
      }
      send(data: Parameters<WebSocket['send']>[0]): void {
        if (this.targeted && target === 'terminal' && typeof data !== 'string' && !(data instanceof Blob)) {
          fault.input.push(new TextDecoder().decode(data));
        }
        if (!this.blocked) super.send(data);
      }
    }
    window.WebSocket = FaultSocket;
    window.recoveryFault = fault;
  }, { target, holdReplacement });
}

const pane = (page: Page) => page.locator('.terminal-pane:not([hidden])');
const online = (page: Page) => page.getByRole('button', { name: 'alpha on Recovery workstation, online', exact: true });

test('a consistently slow inventory response eventually connects to the real terminal', async ({ page }) => {
  let successfulResponses = 0;
  await page.route('**/api/v1/state', async route => {
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    successfulResponses++;
    await new Promise(resolve => setTimeout(resolve, 6000));
    try { await route.fulfill({ response }); } finally { await response.dispose(); }
  });
  await page.goto(machine.origin);
  await expect(online(page)).toBeVisible({ timeout: 18000 });
  await expect(pane(page)).toHaveAttribute('data-mode', 'control');
  await expect(page.locator('.offline-banner')).toBeHidden();
  expect(successfulResponses).toBeGreaterThan(0);
});

for (const trigger of ['heartbeat', 'online wake'] as const) {
  test(`event recovery after ${trigger} does not wait for an old socket close event`, async ({ page }) => {
    await page.clock.install();
    await halfOpenSocket(page, 'events');
    await page.goto(machine.origin);
    await expect(online(page)).toBeVisible();
    await expect(pane(page)).toHaveAttribute('data-mode', 'control');
    await expect.poll(() => page.evaluate(() => window.recoveryFault.ready)).toBe(true);
    await pane(page).evaluate(node => { (node as HTMLElement).dataset.continuity = 'retained'; });
    await page.evaluate(() => window.recoveryFault.stall());
    await page.clock.fastForward(trigger === 'heartbeat' ? 45000 : 26000);
    if (trigger === 'online wake') await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => page.evaluate(() => window.recoveryFault.closeCalls)).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => window.recoveryFault.connections), { timeout: 5000 }).toBeGreaterThan(1);
    await expect(online(page)).toBeVisible();
    await expect(page.locator('.offline-banner')).toBeHidden();
    await expect(pane(page)).toHaveAttribute('data-continuity', 'retained');
    await page.evaluate(() => window.recoveryFault.late());
    await expect(online(page)).toBeVisible();
    await expect(page.getByRole('button', { name: /alpha on Stale workstation/ })).toHaveCount(0);
    await expect(page.locator('.offline-banner')).toBeHidden();
  });
}

test('terminal recovery detaches a stale socket, drops disconnected input and ignores old callbacks', async ({ page }) => {
  await page.clock.install();
  await halfOpenSocket(page, 'terminal', true);
  await page.goto(machine.origin);
  await expect(pane(page)).toHaveAttribute('data-mode', 'control');
  await pane(page).evaluate(node => { (node as HTMLElement).dataset.continuity = 'retained'; });
  await expect.poll(() => page.evaluate(() => window.recoveryFault.ready)).toBe(true);
  await page.evaluate(() => window.recoveryFault.stall());
  await page.clock.fastForward(45000);
  await expect.poll(() => page.evaluate(() => window.recoveryFault.closeCalls)).toBeGreaterThan(0);
  await expect(pane(page)).toHaveAttribute('data-mode', 'disconnected', { timeout: 5000 });
  await expect.poll(() => page.evaluate(() => window.recoveryFault.connections), { timeout: 5000 }).toBeGreaterThan(1);
  await pane(page).locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('EMACHINE_DROPPED_RECOVERY=must_not_replay');
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.recoveryFault.input.join(''))).not.toContain('EMACHINE_DROPPED_RECOVERY=must_not_replay');
  await page.evaluate(() => window.recoveryFault.release());
  await expect(pane(page)).toHaveAttribute('data-mode', 'control');
  await expect(pane(page)).toHaveAttribute('data-continuity', 'retained');
  await page.evaluate(() => window.recoveryFault.late());
  await expect(pane(page)).toHaveAttribute('data-mode', 'control');
  await expect(pane(page).locator('.xterm-rows')).not.toContainText('STALE_SOCKET_OUTPUT');
  await pane(page).locator('.xterm-helper-textarea').focus();
  await page.keyboard.type("printf '__RECOVERY_DROP__%s__END__\\n' \"$EMACHINE_DROPPED_RECOVERY\"");
  await page.keyboard.press('Enter');
  await expect(pane(page).locator('.xterm-rows')).toContainText('__RECOVERY_DROP____END__');
  expect(await page.evaluate(() => window.recoveryFault.input.join(''))).not.toContain('EMACHINE_DROPPED_RECOVERY=must_not_replay');
});
