import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { socketUrl, type Link, type Project } from './transport';
export type Theme = 'dark' | 'light';
export const terminalTheme = (theme: Theme) => theme === 'dark' ? {
  background: '#0c1218', foreground: '#e4eee9', cursor: '#7cddba', cursorAccent: '#0c1218', selectionBackground: '#365c5280',
  black: '#16212a', red: '#ed7985', green: '#82d9a3', yellow: '#ecc780', blue: '#8aaff1', magenta: '#c49ae8', cyan: '#7ad6d2', white: '#dce9e5',
  brightBlack: '#748780', brightRed: '#ff9d9d', brightGreen: '#a4efb6', brightYellow: '#ffe19b', brightBlue: '#b0caff', brightMagenta: '#e0b9ff', brightCyan: '#a2f4df', brightWhite: '#ffffff',
} : {
  background: '#f5f7f3', foreground: '#25372f', cursor: '#167254', cursorAccent: '#f5f7f3', selectionBackground: '#98cbb380',
  black: '#25372f', red: '#a73748', green: '#21744a', yellow: '#88621a', blue: '#345daa', magenta: '#835096', cyan: '#267d7b', white: '#61796e',
  brightBlack: '#698174', brightRed: '#bb4355', brightGreen: '#217c50', brightYellow: '#906d24', brightBlue: '#486caf', brightMagenta: '#9564a9', brightCyan: '#2b8580', brightWhite: '#192e23',
};
function button(label: string, action: () => void, title = label): HTMLButtonElement {
  const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.title = title; b.setAttribute('aria-label', title); b.onclick = action; return b;
}
export class TerminalPane {
  element = document.createElement('section');
  private host = document.createElement('div');
  private status = document.createElement('span');
  private control: HTMLButtonElement;
  private terminal: Terminal;
  private fit = new FitAddon();
  private ws?: WebSocket;
  private observer: ResizeObserver;
  private retry?: number;
  private heartbeat?: number;
  private seen = 0;
  private closed = false;
  private visible = false;
  private reconnects = 0;
  private mode: 'control' | 'observe' = 'observe';
  private generation = 0;
  private route = '';
  private ctrl = false;
  constructor(public link: Link, public project: Project, theme: Theme, private notice: (text: string) => void) {
    this.element.className = 'terminal-pane view';
    this.element.dataset.terminalProject = project.id;
    this.host.className = 'terminal-host';
    const footer = document.createElement('div'); footer.className = 'terminal-footer';
    this.status.textContent = 'Connecting to the project shell…'; this.status.setAttribute('role', 'status');
    this.control = button('Take control', () => this.ws?.readyState === WebSocket.OPEN && this.ws.send(JSON.stringify({ type: 'claim' })));
    this.control.hidden = true;
    footer.append(this.status, this.control);
    const keys = document.createElement('div'); keys.className = 'terminal-keys'; keys.setAttribute('aria-label', 'Terminal keyboard controls');
    const ctrl = button('Ctrl', () => { this.ctrl = !this.ctrl; ctrl.setAttribute('aria-pressed', String(this.ctrl)); this.terminal.focus(); }, 'Use Control with the next character');
    ctrl.setAttribute('aria-pressed', 'false');
    keys.append(ctrl);
    for (const [label, value] of [['Esc', '\u001b'], ['Tab', '\t'], ['↑', '\u001b[A'], ['↓', '\u001b[B'], ['←', '\u001b[D'], ['→', '\u001b[C'], ['Ctrl-C', '\u0003']] as const) {
      keys.append(button(label, () => { this.send(value); this.terminal.focus(); }));
    }
    keys.append(button('Paste', () => {
      navigator.clipboard.readText().then(text => { if (this.mode === 'control' && this.ws?.readyState === WebSocket.OPEN) this.terminal.paste(text); else this.notice('Reconnect and take control before pasting.'); }).catch(() => this.notice('Clipboard access was not granted. Use your device’s Paste command.'));
    }));
    this.element.append(this.host, keys, footer);
    this.terminal = new Terminal({ theme: terminalTheme(theme), fontFamily: 'Iosevka, ui-monospace, monospace', fontSize: 14, lineHeight: 1.15, cursorBlink: true, scrollback: 6000, allowProposedApi: false, convertEol: false });
    this.terminal.loadAddon(this.fit);
    this.terminal.open(this.host);
    this.terminal.onData(data => {
      if (this.ctrl && data.length === 1) { data = String.fromCharCode(data.toUpperCase().charCodeAt(0) & 31); this.ctrl = false; ctrl.setAttribute('aria-pressed', 'false'); }
      this.send(data);
    });
    this.terminal.onBinary(data => {
      if (this.mode === 'control' && this.ws?.readyState === WebSocket.OPEN) this.ws.send(Uint8Array.from(data, character => character.charCodeAt(0) & 255));
    });
    this.terminal.onResize(size => {
      if (this.mode === 'control' && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'resize', ...size }));
    });
    this.observer = new ResizeObserver(() => this.layout());
    this.observer.observe(this.host);
  }
  private send(data: string): void {
    // Input is deliberately discarded while disconnected, never buffered for reconnection.
    if (this.mode === 'control' && this.ws?.readyState === WebSocket.OPEN) this.ws.send(new TextEncoder().encode(data));
  }
  show(show: boolean): void {
    this.visible = show;
    this.element.hidden = !show;
    if (show) requestAnimationFrame(() => { this.layout(); this.connect(); });
  }
  private layout(): void {
    if (!this.visible || !this.element.isConnected || !this.host.clientWidth || this.mode === 'observe' && this.ws?.readyState === WebSocket.OPEN) return;
    const proposed = this.fit.proposeDimensions();
    if (proposed) this.terminal.resize(Math.max(2, Math.min(500, proposed.cols)), Math.max(2, Math.min(500, proposed.rows)));
  }
  update(link: Link, project: Project): void {
    this.link = link; this.project = project;
    if (link.online && link.route && this.route && link.route !== this.route) { this.ws?.close(); this.route = ''; }
    if (link.online && !this.ws) this.connect();
  }
  private connect(): void {
    if (this.closed || !this.link.online || !this.link.route || this.ws) return;
    window.clearTimeout(this.retry);
    this.route = this.link.route;
    const generation = ++this.generation;
    const url = new URL(socketUrl(this.route, `api/v1/terminal/${this.project.id}`));
    url.searchParams.set('cols', String(this.terminal.cols)); url.searchParams.set('rows', String(this.terminal.rows));
    this.terminal.reset();
    this.mode = 'observe'; this.control.hidden = true;
    const ws = new WebSocket(url); ws.binaryType = 'arraybuffer'; this.ws = ws;
    this.status.textContent = 'Attaching to the persistent shell…';
    this.seen = Date.now();
    ws.onopen = () => { this.reconnects = 0; this.seen = Date.now(); };
    ws.onmessage = event => {
      if (this.closed || generation !== this.generation) return;
      this.seen = Date.now();
      if (event.data instanceof ArrayBuffer) { this.terminal.write(new Uint8Array(event.data)); return; }
      try {
        const message = JSON.parse(String(event.data));
        if (message.type === 'state') {
          this.mode = message.mode === 'control' ? 'control' : 'observe';
          this.element.dataset.mode = this.mode;
          this.control.hidden = this.mode === 'control';
          if (this.mode === 'observe') this.terminal.resize(message.cols, message.rows);
          else this.layout();
          this.status.textContent = this.mode === 'control' ? `Live shell · ${message.session}` : `Observing · ${message.cols} × ${message.rows} · another device controls this shell`;
        } else if (message.type === 'error') { this.status.textContent = String(message.message); this.notice(String(message.message)); }
      } catch { this.status.textContent = 'The server sent an invalid terminal control message.'; }
    };
    ws.onclose = () => {
      if (this.closed || generation !== this.generation) return;
      this.ws = undefined; this.mode = 'observe'; this.element.dataset.mode = 'disconnected';
      this.control.hidden = true; this.status.textContent = 'Disconnected · the shell remains on its machine';
      window.clearInterval(this.heartbeat);
      this.retry = window.setTimeout(() => this.connect(), Math.min(12000, 750 * 2 ** this.reconnects++));
    };
    ws.onerror = () => ws.close();
    window.clearInterval(this.heartbeat);
    this.heartbeat = window.setInterval(() => {
      if (Date.now() - this.seen > 30000) { ws.close(); return; }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    }, 10000);
  }
  wake(): void {
    if (this.ws && Date.now() - this.seen > 25000) this.ws.close();
    else this.connect();
    this.layout();
  }
  theme(theme: Theme): void { this.terminal.options.theme = terminalTheme(theme); }
  dispose(): void {
    this.closed = true; this.generation++;
    window.clearTimeout(this.retry); window.clearInterval(this.heartbeat);
    this.ws?.close(); this.observer.disconnect(); this.terminal.dispose(); this.element.remove();
  }
}
