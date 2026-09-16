import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { socketUrl, type Link, type Project } from './transport';
export type Theme = 'dark' | 'light';
export const terminalTheme = (theme: Theme) => theme === 'dark' ? {
  background: '#0c1218', foreground: '#e4eee9', cursor: '#7cddba', cursorAccent: '#0c1218', selectionBackground: '#365c5280',
  black: '#16212a', red: '#ed7985', green: '#82d9a3', yellow: '#ecc780', blue: '#8aaff1', magenta: '#c49ae8', cyan: '#7ad6d2', white: '#dce9e5',
  brightBlack: '#748780', brightRed: '#ff9d9d', brightGreen: '#a4efb6', brightYellow: '#ffe19b', brightBlue: '#b0caff', brightMagenta: '#e0b9ff', brightCyan: '#a2f4df', brightWhite: '#ffffff',
} : {
  background: '#f7f7f7', foreground: '#292929', cursor: '#454545', cursorAccent: '#f7f7f7', selectionBackground: '#a3a3a380',
  black: '#292929', red: '#a73748', green: '#21744a', yellow: '#88621a', blue: '#345daa', magenta: '#835096', cyan: '#267d7b', white: '#666666',
  brightBlack: '#666666', brightRed: '#bb4355', brightGreen: '#217c50', brightYellow: '#906d24', brightBlue: '#486caf', brightMagenta: '#9564a9', brightCyan: '#2b8580', brightWhite: '#202020',
};
function button(label: string, action: () => void, title = label): HTMLButtonElement {
  const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.title = title; b.setAttribute('aria-label', title); b.onclick = action; return b;
}
function modifiedInput(data: string, ctrl: boolean, alt: boolean): string {
  const modifiers = (ctrl ? 4 : 0) | (alt ? 2 : 0);
  if (!modifiers) return data;
  // Cursor modifiers use CSI parameters, including when the terminal uses application cursor keys.
  const cursor = /^\u001b(?:\[1;(\d+)|\[|O)([ABCDHF])$/.exec(data);
  if (cursor) return `\u001b[1;${((Number(cursor[1] ?? 1) - 1) | modifiers) + 1}${cursor[2]}`;
  const prefix = data.length > 1 && data.startsWith('\u001b') ? '\u001b' : '';
  const character = data.slice(prefix.length);
  if (ctrl && /^[a-z@[\]\\^_ ]$/i.test(character)) data = prefix + String.fromCharCode(character.toUpperCase().charCodeAt(0) & 31);
  else if (ctrl && character === '?') data = prefix + '\u007f';
  return alt && !prefix ? '\u001b' + data : data;
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
  constructor(public link: Link, public project: Project, theme: Theme, private notice: (text: string) => void) {
    this.element.className = 'terminal-pane view';
    this.element.dataset.terminalProject = project.id;
    this.host.className = 'terminal-host';
    this.status.className = 'terminal-status'; this.status.textContent = 'Connecting to the project shell…'; this.status.setAttribute('role', 'status');
    this.control = button('Take control', () => { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'claim' })); this.terminal.focus(); });
    this.control.hidden = true;
    const keys = document.createElement('div'); keys.className = 'terminal-keys'; keys.setAttribute('role', 'group'); keys.setAttribute('aria-label', 'Terminal keyboard controls');
    let useCtrl = false, useAlt = false;
    const ctrl = button('Ctrl', () => { useCtrl = !useCtrl; ctrl.setAttribute('aria-pressed', String(useCtrl)); this.terminal.focus(); }, 'Use Control with the next character');
    const alt = button('Alt', () => { useAlt = !useAlt; alt.setAttribute('aria-pressed', String(useAlt)); this.terminal.focus(); }, 'Use Alt with the next key');
    const clearModifiers = () => { useCtrl = useAlt = false; ctrl.setAttribute('aria-pressed', 'false'); alt.setAttribute('aria-pressed', 'false'); };
    clearModifiers();
    keys.append(this.control, ctrl, alt);
    for (const [label, value] of [['Esc', '\u001b'], ['Tab', '\t'], ['↑', '\u001b[A'], ['↓', '\u001b[B'], ['←', '\u001b[D'], ['→', '\u001b[C'], ['Ctrl-C', '\u0003'], ['Alt + ↑', '\u001b[1;3A']] as const) {
      keys.append(button(label, () => { this.terminal.input(value); this.terminal.focus(); }, label === 'Alt + ↑' ? 'Alt + Arrow Up' : label));
    }
    keys.append(button('Copy', () => { void this.copy(); }), button('Paste', () => { clearModifiers(); void this.paste(); }), this.status);
    this.element.append(this.host, keys);
    this.terminal = new Terminal({ theme: terminalTheme(theme), fontFamily: '"JetBrains Mono", "Cascadia Mono", "Liberation Mono", Menlo, Consolas, monospace', fontSize: 14, lineHeight: 1.15, cursorBlink: true, scrollback: 6000, allowProposedApi: false, convertEol: false });
    this.terminal.loadAddon(this.fit);
    // xterm caches fallback cell widths when opened before the bundled fonts load.
    Promise.allSettled([400, 700].map(weight => document.fonts.load(`${weight} ${this.terminal.options.fontSize}px "JetBrains Mono"`))).then(() => {
      if (this.closed) return;
      this.terminal.open(this.host);
      this.layout();
    });
    this.terminal.onData(data => {
      data = modifiedInput(data, useCtrl, useAlt);
      clearModifiers();
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
  private async copy(): Promise<void> {
    const text = this.terminal.getSelection();
    this.terminal.focus();
    if (!text) { this.notice('Select terminal text to copy.'); return; }
    try { await navigator.clipboard.writeText(text); }
    catch { this.notice('Clipboard access was not granted. Use your device’s Copy command.'); }
  }
  private async paste(): Promise<void> {
    this.terminal.focus();
    try {
      const text = await navigator.clipboard.readText();
      if (this.mode === 'control' && this.ws?.readyState === WebSocket.OPEN) this.terminal.paste(text);
      else this.notice('Reconnect and take control before pasting.');
    } catch { this.notice('Clipboard access was not granted. Use your device’s Paste command.'); }
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
    this.status.hidden = false; this.status.textContent = 'Attaching to the persistent shell…';
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
          this.status.hidden = this.mode === 'control';
          this.status.textContent = this.mode === 'control' ? '' : `Observing · ${message.cols} × ${message.rows} · another device controls this shell`;
        } else if (message.type === 'error') { this.status.hidden = false; this.status.textContent = String(message.message); this.notice(String(message.message)); }
      } catch { this.status.hidden = false; this.status.textContent = 'The server sent an invalid terminal control message.'; }
    };
    ws.onclose = () => {
      if (this.closed || generation !== this.generation) return;
      this.ws = undefined; this.mode = 'observe'; this.element.dataset.mode = 'disconnected';
      this.control.hidden = true; this.status.hidden = false; this.status.textContent = 'Disconnected · the shell remains on its machine';
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
