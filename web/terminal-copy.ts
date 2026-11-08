import type { Terminal } from '@xterm/xterm';

export function terminalSnapshot(terminal: Terminal, selection?: ReturnType<Terminal['getSelectionPosition']>) {
  const buffer = terminal.buffer.active;
  let text = '', lastOutput = 0;
  let start: number | undefined, end: number | undefined;
  for (let row = 0; row < buffer.length; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;
    if (row && !line.isWrapped) text += '\n';
    // Buffer columns count cells; DOM range offsets count UTF-16 code units.
    if (selection?.start.y === row) start = text.length + line.translateToString(true, 0, selection.start.x).length;
    if (selection?.end.y === row) end = text.length + line.translateToString(true, 0, selection.end.x).length;
    const contents = line.translateToString(true);
    text += contents;
    if (contents) lastOutput = text.length;
  }
  // Trim empty screen cells, not printed spaces; a TUI may have text below its cursor.
  return { text: text.slice(0, lastOutput), start: Math.min(start ?? lastOutput, lastOutput), end: Math.min(end ?? lastOutput, lastOutput) };
}

let nextId = 0;

export class TerminalCopyOutput {
  readonly element = document.createElement('dialog');
  private text = document.createElement('textarea');
  private selection = document.createElement('button');
  private all = document.createElement('button');
  private status = document.createElement('p');
  private opened?: AbortController;
  private revision = 0;
  private disposed = false;

  constructor(private terminal: Terminal, private trigger: HTMLButtonElement) {
    this.element.id = `terminal-copy-${++nextId}`;
    this.element.className = 'dialog terminal-copy-dialog';
    const title = document.createElement('h2'); title.textContent = 'Copy terminal output';
    title.id = `${this.element.id}-title`; this.element.setAttribute('aria-labelledby', title.id);
    trigger.setAttribute('aria-controls', this.element.id);
    trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-expanded', 'false');
    const close = document.createElement('button');
    close.type = 'button'; close.className = 'text-button'; close.textContent = 'Close';
    close.setAttribute('aria-label', 'Close output'); close.onclick = () => this.close();
    const header = document.createElement('div'); header.className = 'dialog-header'; header.append(title, close);
    const hint = document.createElement('p'); hint.className = 'terminal-copy-hint'; hint.id = `${this.element.id}-hint`;
    hint.textContent = 'Press and hold to adjust the selection. Reopen this view for new output.';
    this.text.className = 'terminal-copy-output'; this.text.readOnly = true; this.text.spellcheck = false;
    this.text.setAttribute('aria-label', 'Terminal output'); this.text.setAttribute('aria-describedby', hint.id);
    this.text.addEventListener('select', () => this.refreshSelection());
    this.status.className = 'terminal-copy-status'; this.status.setAttribute('role', 'status');
    this.selection.type = this.all.type = 'button';
    this.selection.className = this.all.className = 'text-button';
    this.selection.textContent = 'Copy selection'; this.all.textContent = 'Copy all';
    this.selection.onclick = () => { void this.copy(false); };
    this.all.onclick = () => { void this.copy(true); };
    const actions = document.createElement('div'); actions.className = 'terminal-copy-actions'; actions.append(this.selection, this.all);
    this.element.append(header, hint, this.text, this.status, actions);
    this.element.addEventListener('cancel', event => { event.preventDefault(); this.close(); });
    this.element.addEventListener('close', () => { if (!this.element.open) this.clear(); });
  }

  open(selectedText?: string): void {
    if (this.disposed || this.element.open) return;
    this.revision++;
    this.text.value = selectedText ?? terminalSnapshot(this.terminal).text;
    this.status.textContent = selectedText ? "Clipboard access was not granted. Use your device's Copy command for the selected text."
      : this.text.value ? '' : 'No terminal output to copy.';
    this.all.disabled = !this.text.value;
    this.terminal.blur();
    this.element.showModal(); this.trigger.setAttribute('aria-expanded', 'true');
    this.text.focus({ preventScroll: true });
    this.text.setSelectionRange(selectedText ? 0 : this.text.value.length, this.text.value.length);
    this.text.scrollTop = this.text.scrollHeight;
    this.refreshSelection();
    this.opened = new AbortController();
    // Safari can report native selection-handle changes on the document.
    document.addEventListener('selectionchange', () => this.refreshSelection(), { signal: this.opened.signal });
  }

  private refreshSelection(): void {
    this.selection.disabled = this.text.selectionStart === this.text.selectionEnd;
  }

  private async copy(all: boolean): Promise<void> {
    const text = all ? this.text.value : this.text.value.slice(this.text.selectionStart, this.text.selectionEnd);
    if (!this.element.open || !text) return;
    const revision = this.revision;
    try {
      // Start the write in the user's tap; awaiting anything first loses iOS clipboard activation.
      await navigator.clipboard.writeText(text);
      if (revision === this.revision) this.status.textContent = all ? 'Copied all output.' : 'Copied selection.';
    } catch {
      if (revision === this.revision) this.status.textContent = "Clipboard access was not granted. Press and hold the text, then use your device's Copy command.";
    }
  }

  private clear(): void {
    this.revision++; this.opened?.abort(); this.opened = undefined;
    this.text.value = ''; this.status.textContent = '';
    this.selection.disabled = this.all.disabled = true;
    this.trigger.setAttribute('aria-expanded', 'false');
  }

  close(focus = true): void {
    if (!this.element.open) return;
    this.element.close(); this.clear();
    if (focus && this.trigger.isConnected) this.trigger.focus({ preventScroll: true });
  }

  dispose(): void {
    this.disposed = true; this.close(false); this.clear(); this.element.remove();
  }
}
