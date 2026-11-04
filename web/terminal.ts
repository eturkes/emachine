import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { attachTerminalTouchScroll } from './terminal-touch';
import { attachTerminalClipboard } from './terminal-clipboard';
import { TerminalCopyOutput } from './terminal-copy';
import { attachTerminalInput, isIOS } from './terminal-input';
import { decodeTerminalFrame, supportedTerminalEncoding, type TerminalEncoding } from './terminal-encoding';
import { TerminalOutput } from './terminal-output';
import { TerminalReplies } from './terminal-resume';
import { TerminalRestore } from './terminal-restore';
import { TerminalTextInput } from './terminal-text';
import { TerminalPrompts } from './terminal-prompts';
import { TerminalHistory } from './terminal-history';
import { socketUrl, type Link } from './transport';
export type Theme = 'dark' | 'light';
export type TerminalTarget = { kind: 'project'; id: string } | { kind: 'general'; session: string };
// Match the local Black Box terminal palettes.
export const terminalTheme = (theme: Theme) => theme === 'dark' ? {
  background: '#002451', foreground: '#fcfcfc', cursor: '#d6d6d6', cursorAccent: '#002451', selectionBackground: '#a3a3a380',
  black: '#232627', red: '#ed1515', green: '#11d116', yellow: '#f67400', blue: '#1d99f3', magenta: '#9b59b6', cyan: '#1abc9c', white: '#fcfcfc',
  brightBlack: '#7f8c8d', brightRed: '#c0392b', brightGreen: '#1cdc9a', brightYellow: '#fdbc4b', brightBlue: '#3daee9', brightMagenta: '#8e44ad', brightCyan: '#16a085', brightWhite: '#ffffff',
} : {
  background: '#f6f5f4', foreground: '#424242', cursor: '#454545', cursorAccent: '#f6f5f4', selectionBackground: '#a3a3a380',
  scrollbarSliderBackground: '#29292933', scrollbarSliderHoverBackground: '#29292966', scrollbarSliderActiveBackground: '#29292980',
  black: '#212121', red: '#ed1515', green: '#00a600', yellow: '#f67400', blue: '#008ec4', magenta: '#a37acc', cyan: '#1abc9c', white: '#424242',
  brightBlack: '#424242', brightRed: '#fb007a', brightGreen: '#5fd7af', brightYellow: '#f3e430', brightBlue: '#20bbfc', brightMagenta: '#6855de', brightCyan: '#4fb8cc', brightWhite: '#424242',
};
// iOS uses a black OLED surface and a readable dark palette independently of desktop.
const iosDarkTheme = {
  background: '#000000', foreground: '#e7e7e7', cursor: '#d6d6d6', cursorAccent: '#000000', selectionBackground: '#a3a3a380',
  black: '#000000', red: '#ed7985', green: '#82d9a3', yellow: '#ecc780', blue: '#8aaff1', magenta: '#c49ae8', cyan: '#7ad6d2', white: '#dedede',
  brightBlack: '#858585', brightRed: '#ff9d9d', brightGreen: '#a4efb6', brightYellow: '#ffe19b', brightBlue: '#b0caff', brightMagenta: '#e0b9ff', brightCyan: '#a2f4df', brightWhite: '#ffffff',
};
const displayTheme = (theme: Theme) => isIOS() && theme === 'dark' ? iosDarkTheme : terminalTheme(theme);
const contrastRatio = (theme: Theme) => isIOS() && theme === 'dark' ? 4.5 : 1;
function button(label: string, action: (event: MouseEvent) => void, title = label): HTMLButtonElement {
  const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.title = title; b.setAttribute('aria-label', title); b.onclick = action; return b;
}
function controlGroup(label: string, className = 'terminal-key-group'): HTMLDivElement {
  const group = document.createElement('div'); group.className = className; group.setAttribute('role', 'group'); group.setAttribute('aria-label', label); return group;
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
  private output: TerminalOutput;
  private terminalReplies: TerminalReplies;
  private terminalRestore: TerminalRestore;
  private replies: Array<{ epoch: number; data: string }> = [];
  private ready = false;
  private attachment?: { attachment: string; sequence: number };
  private attachmentEpoch = 0;
  private detachTouch?: () => void;
  private detachInput?: () => void;
  private textInput?: TerminalTextInput;
  private prompts: TerminalPrompts;
  private history?: TerminalHistory;
  private clipboard: ReturnType<typeof attachTerminalClipboard>;
  private copyOutput?: TerminalCopyOutput;
  private fit = new FitAddon();
  private ws?: WebSocket;
  private decoding?: AbortController;
  private observer: ResizeObserver;
  private layoutTimer?: number;
  private retry?: number;
  private heartbeat?: number;
  private seen = 0;
  private closed = false;
  private connecting = false;
  private visible = false;
  private reconnects = 0;
  private mode: 'control' | 'observe' = 'observe';
  private generation = 0;
  private route = '';
  private remoteSize = '';
  private pendingSize = '';
  private desiredSize?: { cols: number; rows: number };
  constructor(public link: Link, public target: TerminalTarget, theme: Theme, private notice: (text: string) => void) {
    this.element.className = 'terminal-pane view';
    this.element.classList.toggle('terminal-ios', isIOS());
    if (target.kind === 'project') this.element.dataset.terminalProject = target.id;
    else this.element.dataset.terminalSession = target.session;
    this.host.className = 'terminal-host';
    this.status.className = 'terminal-status'; this.status.textContent = 'Connecting to the shell…'; this.status.setAttribute('role', 'status');
    this.control = button('Take control', () => { if (this.ready && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'claim' })); this.terminal.focus(); });
    this.control.hidden = true;
    const keys = document.createElement('div'); keys.className = 'terminal-keys';
    const navigation = controlGroup('Navigation');
    const shortcuts = controlGroup('Key combinations');
    const session = controlGroup('Terminal session', 'terminal-session');
    const textTools = controlGroup('Text tools');
    const promptTools = controlGroup('Prompt tools');
    for (const [group, label, value] of [
      [keys, 'Enter', '\r'],
      [navigation, '←', '\u001b[D'], [navigation, '↓', '\u001b[B'], [navigation, '↑', '\u001b[A'], [navigation, '→', '\u001b[C'],
      [shortcuts, 'Shift + ←', '\u001b[1;2D'], [shortcuts, 'Ctrl-C', '\u0003'],
      [shortcuts, 'Ctrl-O', '\u000f'], [shortcuts, 'Ctrl-E', '\u0005'],
    ] as const) {
      const arrow = /^\u001b\[([ABCD])$/.exec(value);
      let keyboardBeforeTap: boolean | undefined;
      const key = button(label, event => {
        const focus = !arrow || !isIOS() || ((event.detail > 0 ? keyboardBeforeTap : undefined) ?? this.keyboardShown);
        keyboardBeforeTap = undefined;
        this.terminal.input(arrow && this.terminal.modes.applicationCursorKeysMode ? `\u001bO${arrow[1]}` : value);
        if (focus) this.terminal.focus();
      }, label === 'Shift + ←' ? 'Shift + Arrow Left' : label);
      if (arrow && isIOS()) {
        const { signal } = this.keyboardEvents;
        // Navigate selectors without opening a hidden keyboard or blurring an open one.
        key.addEventListener('pointerdown', event => {
          if (event.isPrimary && event.button === 0) keyboardBeforeTap = this.keyboardShown;
        }, { signal });
        key.addEventListener('pointercancel', () => { keyboardBeforeTap = undefined; }, { signal });
        key.addEventListener('mousedown', event => {
          if (event.button === 0 && document.activeElement === this.terminal.textarea) event.preventDefault();
        }, { signal });
      }
      group.append(key);
    }
    shortcuts.append(button('Ctrl-X Ctrl-S', () => { this.terminal.input('\u0018\u0013'); this.terminal.focus(); }, 'Ctrl+X then Ctrl+S'));
    session.append(this.status, this.control);
    keys.append(navigation, shortcuts);
    const copy = () => { void this.copy(); };
    const paste = () => { void this.paste(); };
    const copyButton = button('Copy', copy);
    textTools.append(copyButton, button('Paste', paste));
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
    const tab = button('Tab', () => { this.terminal.input('\t'); this.terminal.focus(); });
    tab.className = 'terminal-fixed-key';
    const keyboardControls = controlGroup('Terminal keyboard controls', 'terminal-keyboard-controls');
    keyboardControls.append(this.keyboard, escape, tab, keys);
    const tools = document.createElement('div'); tools.className = 'terminal-tools'; tools.append(textTools, promptTools);
    const toolbar = controlGroup('Terminal controls', 'terminal-toolbar');
    toolbar.append(keyboardControls, tools);
    const main = document.createElement('div'); main.className = 'terminal-main';
    main.append(this.host, session, toolbar); this.element.append(main);
    // Only iOS dark mode corrects contrast; bold keeps the requested palette entry.
    this.terminal = new Terminal({
      theme: displayTheme(theme), minimumContrastRatio: contrastRatio(theme), drawBoldTextInBrightColors: false,
      fontFamily: '"JetBrains Mono", "Cascadia Mono", "Liberation Mono", Menlo, Consolas, monospace',
      fontSize: 14, lineHeight: 1.15, cursorBlink: true, scrollback: 10000, allowProposedApi: false, convertEol: false,
    });
    this.output = new TerminalOutput(this.terminal);
    this.terminalReplies = new TerminalReplies(this.terminal);
    this.terminalRestore = new TerminalRestore(this.terminal, () => {
      queueMicrotask(() => { if (!this.closed) this.refreshControl(); });
    });
    this.terminal.loadAddon(this.fit);
    const canInput = () => this.canInput();
    this.clipboard = attachTerminalClipboard(this.host, this.terminal, { copy, paste, canPaste: canInput });
    if (isIOS()) {
      this.copyOutput = new TerminalCopyOutput(this.terminal, copyButton);
      this.element.append(this.copyOutput.element);
      this.textInput = new TerminalTextInput({
        canSend: canInput,
        send: text => {
          if (!canInput()) return false;
          this.terminal.paste(text); return true;
        },
        focusTerminal: () => this.terminal.focus(),
      });
      this.host.after(this.textInput.element); textTools.prepend(this.textInput.button);
    }
    this.prompts = new TerminalPrompts({
      link: () => this.link,
      canPaste: () => this.visible && canInput(),
      paste: text => {
        if (!this.visible || !canInput()) return false;
        this.terminal.paste(text); return true;
      },
      focusTerminal: () => { if (this.visible && !this.closed) this.terminal.focus(); },
    });
    this.element.append(this.prompts.element); promptTools.append(this.prompts.button);
    if (target.kind === 'project') {
      this.history = new TerminalHistory({
        link: () => this.link,
        project: () => this.target.kind === 'project' ? this.target.id : '',
        focusTerminal: () => { if (this.visible && !this.closed) this.terminal.focus(); },
      });
      this.element.append(this.history.element); promptTools.append(this.history.button);
    }
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
      if (this.terminalReplies.generated) {
        if (this.canInput()) this.send(data);
        // These replies have never been sent. Parsing may finish after socket loss,
        // and catch-up can contain old observer roles. Ready supplies the current role.
        else if (!this.closed && !this.ready && this.attachment) this.replies.push({ epoch: this.attachmentEpoch, data });
        return;
      }
      this.send(data);
    });
    this.terminal.onBinary(data => {
      if (this.canInput()) this.ws!.send(Uint8Array.from(data, character => character.charCodeAt(0) & 255));
    });
    this.observer = new ResizeObserver(() => {
      // Keyboard animations produce several temporary grids; resize the PTY once they settle.
      window.clearTimeout(this.layoutTimer);
      this.layoutTimer = window.setTimeout(() => this.layout(), 100);
    });
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
  private canInput(): boolean {
    return !this.closed && this.ready && this.mode === 'control' && this.ws?.readyState === WebSocket.OPEN;
  }
  private send(data: string): void {
    // Input is deliberately discarded while disconnected, never buffered for reconnection.
    if (this.canInput()) this.ws!.send(new TextEncoder().encode(data));
  }
  private syncSize(): void {
    if (!this.visible || !this.desiredSize || !this.canInput() || this.pendingSize) return;
    const { cols, rows } = this.desiredSize, size = `${cols}x${rows}`;
    if (size === this.remoteSize) return;
    this.pendingSize = size;
    this.ws!.send(JSON.stringify({ type: 'resize', cols, rows }));
  }
  private async copy(): Promise<void> {
    const text = this.terminal.getSelection();
    if (!text && this.copyOutput) { this.copyOutput.open(); return; }
    this.terminal.focus();
    if (!text) { this.notice('Select terminal text to copy.'); return; }
    try { await navigator.clipboard.writeText(text); }
    catch { this.notice('Clipboard access was not granted. Use your device’s Copy command.'); }
  }
  private async paste(): Promise<void> {
    this.terminal.focus();
    try {
      const text = await navigator.clipboard.readText();
      if (this.canInput()) this.terminal.paste(text);
      else this.notice('Reconnect and take control before pasting.');
    } catch { this.notice('Clipboard access was not granted. Use your device’s Paste command.'); }
  }
  show(show: boolean): void {
    this.visible = show;
    this.element.hidden = !show;
    if (!show) this.clipboard.close();
    // A render hides every pane before showing the active one again.
    if (!show) queueMicrotask(() => { if (!this.visible) { this.prompts.close(false); this.history?.close(false); this.copyOutput?.close(false); } });
    if (show) requestAnimationFrame(() => { this.layout(); this.connect(); });
  }
  private layout(): void {
    window.clearTimeout(this.layoutTimer);
    this.output.run(() => this.fitTerminal());
  }
  private fitTerminal(): void {
    if (this.closed || !this.visible || !this.element.isConnected || !this.host.clientWidth) return;
    const fontSize = Number(getComputedStyle(this.element).getPropertyValue('--terminal-font-size'));
    if (fontSize > 0 && this.terminal.options.fontSize !== fontSize) this.terminal.options.fontSize = fontSize;
    if (this.mode === 'observe' && this.ws) return;
    const proposed = this.fit.proposeDimensions();
    if (!proposed) return;
    this.desiredSize = { cols: Math.max(2, Math.min(500, proposed.cols)), rows: Math.max(2, Math.min(500, proposed.rows)) };
    // Keep parsing in-flight output on its old grid until the server orders the resize.
    if (this.ws) this.syncSize();
    else if (!this.attachment) this.terminal.resize(this.desiredSize.cols, this.desiredSize.rows);
  }
  update(link: Link, target: TerminalTarget): void {
    this.link = link; this.target = target;
    if (link.online && link.route && this.route && link.route !== this.route) { this.disconnect(this.ws); this.route = ''; }
    if (link.online && !this.ws) this.connect();
    this.prompts.update();
    this.history?.update();
  }
  private connect(): void {
    if (this.connecting || this.closed || !this.terminal.element || !this.visible && !this.route || !this.link.online || !this.link.route || this.ws) return;
    this.connecting = true;
    // Resume only from a checkpoint whose accepted bytes and geometry have all been parsed.
    const attach = () => { this.connecting = false; this.attach(); };
    if (this.attachment) this.output.run(attach);
    else this.output.reset(attach);
  }
  private attach(): void {
    // Attach only after font-backed fitting; a default-sized replay can corrupt a live TUI.
    if (this.closed || !this.terminal.element || !this.visible && !this.route || !this.link.online || !this.link.route || this.ws) return;
    this.fitTerminal();
    window.clearTimeout(this.retry);
    this.route = this.link.route;
    const generation = ++this.generation;
    const path = this.target.kind === 'project' ? this.target.id : `general/${encodeURIComponent(this.target.session)}`;
    const url = new URL(socketUrl(this.route, `api/v1/terminal/${path}`));
    url.searchParams.set('cols', String(this.terminal.cols)); url.searchParams.set('rows', String(this.terminal.rows));
    url.searchParams.set('resume', '1');
    const checkpoint = this.attachment && { ...this.attachment };
    let protocol: 'waiting' | 'resume' | 'legacy' = 'waiting';
    const requestedEncoding = supportedTerminalEncoding();
    let encoding: TerminalEncoding | undefined;
    let epoch = this.attachmentEpoch, received = checkpoint?.sequence ?? 0;
    this.ready = false; this.pendingSize = '';
    if (!this.attachment) this.replies = [];
    this.control.hidden = true; this.element.dataset.mode = 'attaching';
    const ws = new WebSocket(url); ws.binaryType = 'arraybuffer'; this.ws = ws;
    const decoding = this.decoding = new AbortController();
    const current = () => !this.closed && generation === this.generation && this.ws === ws;
    const sameAttachment = () => !this.closed && epoch === this.attachmentEpoch;
    const reset = () => {
      epoch = ++this.attachmentEpoch;
      this.replies = [];
      this.output.reset(() => {
        if (!sameAttachment()) return;
        this.terminalRestore.reset(); this.terminal.reset(); this.remoteSize = this.pendingSize = ''; this.mode = 'observe';
      });
    };
    const legacy = () => {
      if (protocol !== 'waiting') return;
      protocol = 'legacy'; this.attachment = undefined; reset();
    };
    const accept = (sequence: unknown): number => {
      if (!Number.isSafeInteger(sequence) || sequence !== received + 1) throw new Error('Invalid terminal sequence');
      received = sequence as number;
      return received;
    };
    const applied = (sequence: number) => {
      if (sameAttachment() && this.attachment) this.attachment.sequence = sequence;
    };
    const invalid = () => {
      this.attachment = undefined; this.attachmentEpoch++;
      this.disconnect(ws);
      this.status.textContent = 'Terminal restoration was interrupted. Reattaching to the shell...';
    };
    this.textInput?.refresh();
    this.prompts.refresh();
    this.status.hidden = false; this.status.textContent = 'Attaching to the persistent shell…';
    this.seen = Date.now();
    ws.onopen = () => {
      if (!current()) return;
      this.seen = Date.now();
      ws.send(JSON.stringify({ type: 'resume', ...checkpoint, encoding: requestedEncoding }));
    };
    const receive = (payload: ArrayBuffer | string): void | Promise<void> => {
      try {
        if (payload instanceof ArrayBuffer) {
          if (protocol === 'waiting') legacy();
          const data = new Uint8Array(payload);
          if (protocol === 'legacy') this.output.write(data);
          else {
            if (data.length < 8) throw new Error('Missing terminal sequence');
            const sequence = accept(Number(new DataView(payload).getBigUint64(0)));
            const decoded = decodeTerminalFrame(data, encoding, decoding.signal);
            if (decoded instanceof Uint8Array) this.output.write(decoded, () => applied(sequence));
            else return decoded.then(bytes => {
              if (current()) this.output.write(bytes, () => applied(sequence));
            });
          }
          return;
        }
        const message = JSON.parse(String(payload));
        if (message.type === 'resume') {
          if (protocol !== 'waiting' || !/^[a-f0-9]{32}$/.test(message.attachment) || typeof message.resumed !== 'boolean' || !Number.isSafeInteger(message.sequence)) throw new Error('Invalid terminal resume');
          if (message.encoding !== undefined && (message.encoding !== 'gzip-v1' || requestedEncoding !== 'gzip-v1')) throw new Error('Unrequested terminal encoding');
          encoding = message.encoding;
          if (message.resumed) {
            if (!checkpoint || message.attachment !== checkpoint.attachment || message.sequence !== checkpoint.sequence) throw new Error('Mismatched terminal resume');
          } else {
            if (message.sequence !== 0) throw new Error('Invalid fresh terminal checkpoint');
            reset(); this.attachment = { attachment: message.attachment, sequence: 0 };
          }
          received = message.sequence; protocol = 'resume';
        } else if (message.type === 'state') {
          legacy();
          const sequence = protocol === 'resume' ? accept(message.sequence) : undefined;
          const cols = message.screenCols ?? message.cols, rows = message.screenRows ?? message.rows;
          if (![message.cols, message.rows, cols, rows].every(value => Number.isInteger(value) && value >= 2 && value <= 500)) throw new Error('Invalid terminal geometry');
          this.output.run(() => {
            // Accepted state belongs to the attachment, including while its socket is lost.
            if (!sameAttachment()) return;
            const mode = message.mode === 'control' ? 'control' : 'observe';
            const gainedControl = mode === 'control' && this.mode !== 'control';
            this.remoteSize = `${message.cols}x${message.rows}`;
            if (this.remoteSize === this.pendingSize || mode !== this.mode) this.pendingSize = '';
            this.mode = mode;
            if (this.ready && mode !== 'control') this.replies = [];
            // zmx can keep a manual terminal's grid even after accepting our attachment size.
            this.terminal.resize(cols, rows);
            if (sequence !== undefined) applied(sequence);
            if (current()) {
              if (protocol === 'legacy') { this.ready = true; this.reconnects = 0; }
              this.refreshControl(gainedControl);
            }
          });
        } else if (message.type === 'ready' && protocol === 'resume') {
          // Ready ends reconnect catch-up. A fresh attachment still negotiates zmx's
          // capabilities and receives its initial snapshot as subsequent live output.
          this.output.run(() => {
            if (!sameAttachment() || !current()) return;
            this.ready = true; this.reconnects = 0;
            this.refreshControl(true);
            for (const reply of this.replies) if (reply.epoch === epoch) this.send(reply.data);
            this.replies = [];
          });
        } else if (message.type === 'error') { this.status.hidden = false; this.status.textContent = String(message.message); this.notice(String(message.message)); }
      } catch { invalid(); }
    };
    const queued: Array<ArrayBuffer | string> = [];
    let inflating = false;
    decoding.signal.addEventListener('abort', () => { queued.length = 0; }, { once: true });
    const drain = () => {
      if (inflating) return;
      while (current() && queued.length) {
        const pending = receive(queued.shift()!);
        if (pending) {
          inflating = true;
          void pending.then(() => { inflating = false; drain(); }, () => {
            inflating = false; queued.length = 0;
            if (current()) invalid();
          });
          return;
        }
      }
      if (!current()) queued.length = 0;
    };
    ws.onmessage = event => {
      if (!current()) return;
      this.seen = Date.now();
      // Geometry and ready cannot overtake an asynchronous gzip frame.
      queued.push(event.data); drain();
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
  private refreshControl(fit = false): void {
    this.textInput?.refresh(); this.prompts.refresh();
    if (!this.ready || this.ws?.readyState !== WebSocket.OPEN) return;
    this.element.dataset.mode = this.mode;
    this.control.hidden = this.mode === 'control';
    // Resolve the status row before fitting the space freed by taking control.
    this.status.hidden = this.mode === 'control' && !this.terminalRestore.active;
    this.status.textContent = this.terminalRestore.active ? 'Restoring terminal history…'
      : this.mode === 'control' ? '' : `Observing · ${this.terminal.cols} × ${this.terminal.rows} · another device controls this shell`;
    if (this.mode === 'control') {
      if (fit) this.fitTerminal();
      // Coalesce viewport changes while a previous resize is awaiting acknowledgement.
      this.syncSize();
    }
  }
  private disconnect(ws: WebSocket | undefined): void {
    if (!ws || this.closed || this.ws !== ws) return;
    // Drop local input/control immediately, independently of the browser's close handshake.
    this.ws = undefined; this.generation++; this.ready = false;
    this.decoding?.abort(); this.decoding = undefined;
    this.element.dataset.mode = 'disconnected';
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
  theme(theme: Theme): void {
    this.terminal.options.minimumContrastRatio = contrastRatio(theme);
    this.terminal.options.theme = displayTheme(theme);
  }
  dispose(): void {
    this.closed = true; this.generation++;
    this.decoding?.abort(); this.decoding = undefined;
    window.clearTimeout(this.retry); window.clearInterval(this.heartbeat);
    window.clearTimeout(this.layoutTimer);
    this.keyboardEvents.abort();
    this.detachInput?.(); this.detachTouch?.(); this.clipboard.dispose(); this.textInput?.dispose();
    this.prompts.dispose();
    this.history?.dispose();
    this.copyOutput?.dispose();
    if (this.attachment && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'detach' }));
    this.ws?.close(); this.observer.disconnect(); this.output.dispose(); this.terminalReplies.dispose(); this.terminalRestore.dispose(); this.terminal.dispose(); this.element.remove();
  }
}
