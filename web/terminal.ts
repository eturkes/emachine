import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { attachTerminalTouchScroll } from './terminal-touch';
import { attachTerminalClipboard } from './terminal-clipboard';
import { attachTerminalInput, isIOS } from './terminal-input';
import { TerminalTextInput } from './terminal-text';
import { TerminalPrompts } from './terminal-prompts';
import { socketUrl, type Link } from './transport';
export type Theme = 'dark' | 'light';
export type TerminalTarget = { kind: 'project'; id: string } | { kind: 'general'; session: string };
export const terminalTheme = (theme: Theme) => theme === 'dark' ? {
  background: '#151515', foreground: '#e7e7e7', cursor: '#d6d6d6', cursorAccent: '#151515', selectionBackground: '#a3a3a380',
  black: '#202020', red: '#ed7985', green: '#82d9a3', yellow: '#ecc780', blue: '#8aaff1', magenta: '#c49ae8', cyan: '#7ad6d2', white: '#dedede',
  brightBlack: '#858585', brightRed: '#ff9d9d', brightGreen: '#a4efb6', brightYellow: '#ffe19b', brightBlue: '#b0caff', brightMagenta: '#e0b9ff', brightCyan: '#a2f4df', brightWhite: '#ffffff',
} : {
  background: '#f7f7f7', foreground: '#292929', cursor: '#454545', cursorAccent: '#f7f7f7', selectionBackground: '#a3a3a380',
  black: '#292929', red: '#a73748', green: '#21744a', yellow: '#88621a', blue: '#345daa', magenta: '#835096', cyan: '#267d7b', white: '#666666',
  brightBlack: '#666666', brightRed: '#bb4355', brightGreen: '#217c50', brightYellow: '#906d24', brightBlue: '#486caf', brightMagenta: '#9564a9', brightCyan: '#2b8580', brightWhite: '#202020',
};
function button(label: string, action: (event: MouseEvent) => void, title = label): HTMLButtonElement {
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
  private keyboard: HTMLButtonElement;
  private keyboardShown = false;
  private keyboardTap?: boolean;
  private keyboardEvents = new AbortController();
  private terminal: Terminal;
  private detachTouch?: () => void;
  private detachInput?: () => void;
  private textInput?: TerminalTextInput;
  private prompts: TerminalPrompts;
  private clipboard: ReturnType<typeof attachTerminalClipboard>;
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
  private remoteSize = '';
  private pendingSize = '';
  constructor(public link: Link, public target: TerminalTarget, theme: Theme, private notice: (text: string) => void) {
    this.element.className = 'terminal-pane view';
    this.element.classList.toggle('terminal-ios', isIOS());
    if (target.kind === 'project') this.element.dataset.terminalProject = target.id;
    else this.element.dataset.terminalSession = target.session;
    this.host.className = 'terminal-host';
    this.status.className = 'terminal-status'; this.status.textContent = 'Connecting to the shell…'; this.status.setAttribute('role', 'status');
    this.control = button('Take control', () => { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'claim' })); this.terminal.focus(); });
    this.control.hidden = true;
    const keys = document.createElement('div'); keys.className = 'terminal-keys';
    let useCtrl = false, useAlt = false;
    const ctrl = button('Ctrl', () => { useCtrl = !useCtrl; ctrl.setAttribute('aria-pressed', String(useCtrl)); this.terminal.focus(); }, 'Use Control with the next character');
    const alt = button('Alt', () => { useAlt = !useAlt; alt.setAttribute('aria-pressed', String(useAlt)); this.terminal.focus(); }, 'Use Alt with the next key');
    const clearModifiers = () => { useCtrl = useAlt = false; ctrl.setAttribute('aria-pressed', 'false'); alt.setAttribute('aria-pressed', 'false'); };
    clearModifiers();
    keys.append(this.control, ctrl, alt);
    for (const [label, value] of [['Tab', '\t'], ['Enter', '\r'], ['↑', '\u001b[A'], ['↓', '\u001b[B'], ['←', '\u001b[D'], ['→', '\u001b[C'], ['Ctrl-C', '\u0003'], ['Shift + ←', '\u001b[1;2D']] as const) {
      keys.append(button(label, () => { this.terminal.input(value); this.terminal.focus(); }, label === 'Shift + ←' ? 'Shift + Arrow Left' : label));
    }
    keys.append(button('Ctrl-X Ctrl-S', () => { clearModifiers(); this.terminal.input('\u0018\u0013'); this.terminal.focus(); }, 'Ctrl+X then Ctrl+S'));
    const copy = () => { void this.copy(); };
    const paste = () => { clearModifiers(); void this.paste(); };
    keys.append(button('Copy', copy), button('Paste', paste), this.status);
    this.keyboard = button('Keyboard', event => {
      const hide = (event.detail > 0 ? this.keyboardTap : undefined) ?? this.keyboardShown;
      this.keyboardTap = undefined;
      this.textInput?.close();
      // iOS can dismiss its keyboard while leaving the textarea focused. Refocus in this gesture.
      this.terminal.blur();
      if (!hide) this.terminal.focus();
      this.setKeyboardShown(!hide);
    }, 'Toggle terminal keyboard');
    this.keyboard.className = 'terminal-keyboard terminal-fixed-key'; this.keyboard.disabled = true;
    this.setKeyboardShown(false);
    // Capture before the button can blur the input; cancelling pointerdown suppresses taps in WebKit.
    this.keyboard.addEventListener('pointerdown', event => {
      if (event.isPrimary && event.button === 0) this.keyboardTap = this.keyboardShown;
    }, { signal: this.keyboardEvents.signal });
    this.keyboard.addEventListener('pointercancel', () => { this.keyboardTap = undefined; }, { signal: this.keyboardEvents.signal });
    const escape = button('Esc', () => { this.terminal.input('\u001b'); this.terminal.focus(); });
    escape.className = 'terminal-fixed-key';
    const toolbar = document.createElement('div'); toolbar.className = 'terminal-toolbar'; toolbar.setAttribute('role', 'group'); toolbar.setAttribute('aria-label', 'Terminal keyboard controls');
    toolbar.append(this.keyboard, escape, keys);
    this.element.append(this.host, toolbar);
    this.terminal = new Terminal({ theme: terminalTheme(theme), fontFamily: '"JetBrains Mono", "Cascadia Mono", "Liberation Mono", Menlo, Consolas, monospace', fontSize: 14, lineHeight: 1.15, cursorBlink: true, scrollback: 6000, allowProposedApi: false, convertEol: false });
    this.terminal.loadAddon(this.fit);
    const canInput = () => !this.closed && this.mode === 'control' && this.ws?.readyState === WebSocket.OPEN;
    this.clipboard = attachTerminalClipboard(this.host, this.terminal, { copy, paste, canPaste: canInput });
    if (isIOS()) {
      this.textInput = new TerminalTextInput({
        canSend: canInput,
        send: text => {
          if (!canInput()) return false;
          clearModifiers(); this.terminal.paste(text); return true;
        },
        focusTerminal: () => this.terminal.focus(),
      });
      this.host.after(this.textInput.element); keys.prepend(this.textInput.button);
    }
    this.prompts = new TerminalPrompts({
      link: () => this.link,
      canPaste: () => this.visible && canInput(),
      paste: text => {
        if (!this.visible || !canInput()) return false;
        clearModifiers(); this.terminal.paste(text); return true;
      },
      focusTerminal: () => { if (this.visible && !this.closed) this.terminal.focus(); },
    });
    this.element.append(this.prompts.element); keys.prepend(this.prompts.button);
    // xterm caches fallback cell widths when opened before the bundled fonts load.
    Promise.allSettled([400, 700].map(weight => document.fonts.load(`${weight} ${this.terminal.options.fontSize}px "JetBrains Mono"`))).then(() => {
      if (this.closed) return;
      this.terminal.open(this.host);
      this.detachInput = attachTerminalInput(this.host, this.terminal);
      this.detachTouch = attachTerminalTouchScroll(this.host, this.terminal);
      this.attachKeyboard();
      this.keyboard.disabled = false;
      this.layout();
      this.connect();
    });
    this.terminal.onData(data => {
      data = modifiedInput(data, useCtrl, useAlt);
      clearModifiers();
      this.send(data);
    });
    this.terminal.onBinary(data => {
      if (this.mode === 'control' && this.ws?.readyState === WebSocket.OPEN) this.ws.send(Uint8Array.from(data, character => character.charCodeAt(0) & 255));
    });
    this.terminal.onResize(() => this.syncSize());
    this.observer = new ResizeObserver(() => this.layout());
    this.observer.observe(this.host);
  }
  private setKeyboardShown(shown: boolean): void {
    this.keyboardShown = shown;
    this.keyboard.setAttribute('aria-pressed', String(shown));
  }
  private attachKeyboard(): void {
    const input = this.terminal.textarea;
    if (!input) return;
    const { signal } = this.keyboardEvents;
    input.addEventListener('focus', () => this.setKeyboardShown(true), { signal });
    input.addEventListener('blur', () => this.setKeyboardShown(false), { signal });
    this.setKeyboardShown(document.activeElement === input);
    const viewport = window.visualViewport;
    if (!isIOS() || !viewport) return;
    let occluded = false;
    const resized = () => {
      const previous = occluded;
      // Docked iOS keyboards shrink the visual viewport; discount pinch and small browser-chrome changes.
      occluded = document.documentElement.clientHeight - viewport.height * viewport.scale > 100;
      // Only a detected open → closed transition overrides focus; floating keyboards may not resize.
      if (document.activeElement === input && (occluded || previous)) this.setKeyboardShown(occluded);
    };
    viewport.addEventListener('resize', resized, { signal });
    resized();
  }
  private send(data: string): void {
    // Input is deliberately discarded while disconnected, never buffered for reconnection.
    if (this.mode === 'control' && this.ws?.readyState === WebSocket.OPEN) this.ws.send(new TextEncoder().encode(data));
  }
  private syncSize(): void {
    if (this.mode !== 'control' || this.ws?.readyState !== WebSocket.OPEN) return;
    const { cols, rows } = this.terminal, size = `${cols}x${rows}`;
    if (size === this.remoteSize || size === this.pendingSize) return;
    this.pendingSize = size;
    this.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
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
    if (!show) this.clipboard.close();
    // A render hides every pane before showing the active one again.
    if (!show) queueMicrotask(() => { if (!this.visible) this.prompts.close(false); });
    if (show) requestAnimationFrame(() => { this.layout(); this.connect(); });
  }
  private layout(): void {
    if (!this.visible || !this.element.isConnected || !this.host.clientWidth) return;
    const fontSize = Number(getComputedStyle(this.element).getPropertyValue('--terminal-font-size'));
    if (fontSize > 0 && this.terminal.options.fontSize !== fontSize) this.terminal.options.fontSize = fontSize;
    if (this.mode === 'observe' && this.ws) return;
    const proposed = this.fit.proposeDimensions();
    if (proposed) this.terminal.resize(Math.max(2, Math.min(500, proposed.cols)), Math.max(2, Math.min(500, proposed.rows)));
  }
  update(link: Link, target: TerminalTarget): void {
    this.link = link; this.target = target;
    if (link.online && link.route && this.route && link.route !== this.route) { this.disconnect(this.ws); this.route = ''; }
    if (link.online && !this.ws) this.connect();
    this.prompts.update();
  }
  private connect(): void {
    // Attach only after font-backed fitting; a default-sized replay can corrupt a live TUI.
    if (this.closed || !this.terminal.element || !this.visible && !this.route || !this.link.online || !this.link.route || this.ws) return;
    window.clearTimeout(this.retry);
    this.route = this.link.route;
    const generation = ++this.generation;
    const path = this.target.kind === 'project' ? this.target.id : `general/${this.target.session}`;
    const url = new URL(socketUrl(this.route, `api/v1/terminal/${path}`));
    url.searchParams.set('cols', String(this.terminal.cols)); url.searchParams.set('rows', String(this.terminal.rows));
    this.terminal.reset();
    this.remoteSize = this.pendingSize = '';
    this.mode = 'observe'; this.control.hidden = true;
    const ws = new WebSocket(url); ws.binaryType = 'arraybuffer'; this.ws = ws;
    this.textInput?.refresh();
    this.prompts.refresh();
    this.status.hidden = false; this.status.textContent = 'Attaching to the persistent shell…';
    this.seen = Date.now();
    ws.onopen = () => {
      if (this.closed || generation !== this.generation || this.ws !== ws) return;
      this.reconnects = 0; this.seen = Date.now();
    };
    ws.onmessage = event => {
      if (this.closed || generation !== this.generation || this.ws !== ws) return;
      this.seen = Date.now();
      if (event.data instanceof ArrayBuffer) { this.terminal.write(new Uint8Array(event.data)); return; }
      try {
        const message = JSON.parse(String(event.data));
        if (message.type === 'state') {
          const mode = message.mode === 'control' ? 'control' : 'observe';
          this.remoteSize = `${message.cols}x${message.rows}`;
          if (this.remoteSize === this.pendingSize || mode !== this.mode) this.pendingSize = '';
          this.mode = mode;
          this.textInput?.refresh();
          this.prompts.refresh();
          this.element.dataset.mode = this.mode;
          this.control.hidden = this.mode === 'control';
          if (this.mode === 'observe') this.terminal.resize(message.cols, message.rows);
          else {
            this.layout();
            // A fit completed before control can leave onResize silent despite a remote mismatch.
            this.syncSize();
          }
          this.status.hidden = this.mode === 'control';
          this.status.textContent = this.mode === 'control' ? '' : `Observing · ${message.cols} × ${message.rows} · another device controls this shell`;
        } else if (message.type === 'error') { this.status.hidden = false; this.status.textContent = String(message.message); this.notice(String(message.message)); }
      } catch { this.status.hidden = false; this.status.textContent = 'The server sent an invalid terminal control message.'; }
    };
    const disconnect = () => { if (generation === this.generation) this.disconnect(ws); };
    ws.onclose = disconnect;
    ws.onerror = disconnect;
    window.clearInterval(this.heartbeat);
    this.heartbeat = window.setInterval(() => {
      if (this.closed || generation !== this.generation || this.ws !== ws) return;
      if (Date.now() - this.seen > 30000) { this.disconnect(ws); return; }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    }, 10000);
  }
  private disconnect(ws: WebSocket | undefined): void {
    if (!ws || this.closed || this.ws !== ws) return;
    // Drop local input/control immediately, independently of the browser's close handshake.
    this.ws = undefined; this.generation++;
    this.mode = 'observe'; this.element.dataset.mode = 'disconnected';
    this.textInput?.refresh();
    this.prompts.refresh();
    this.control.hidden = true; this.status.hidden = false; this.status.textContent = 'Disconnected · the shell remains on its machine';
    window.clearInterval(this.heartbeat);
    window.clearTimeout(this.retry);
    this.retry = window.setTimeout(() => this.connect(), Math.min(12000, 750 * 2 ** this.reconnects++));
    ws.close();
  }
  wake(): void {
    if (this.ws && Date.now() - this.seen > 25000) this.disconnect(this.ws);
    this.connect();
    this.layout();
  }
  theme(theme: Theme): void { this.terminal.options.theme = terminalTheme(theme); }
  dispose(): void {
    this.closed = true; this.generation++;
    window.clearTimeout(this.retry); window.clearInterval(this.heartbeat);
    this.keyboardEvents.abort();
    this.detachInput?.(); this.detachTouch?.(); this.clipboard.dispose(); this.textInput?.dispose();
    this.prompts.dispose();
    this.ws?.close(); this.observer.disconnect(); this.terminal.dispose(); this.element.remove();
  }
}
