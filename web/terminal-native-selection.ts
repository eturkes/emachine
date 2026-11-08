import type { Terminal } from '@xterm/xterm';
import { terminalSnapshot } from './terminal-copy';

export function attachNativeSelection(pane: HTMLElement, host: HTMLElement, terminal: Terminal, copy: HTMLButtonElement) {
  const display = document.createElement('div'); display.className = 'terminal-display';
  host.before(display); display.append(host);
  const view = document.createElement('section'); view.className = 'terminal-native-selection'; view.hidden = true;
  view.setAttribute('aria-label', 'Select terminal text');
  const bar = document.createElement('div'); bar.className = 'terminal-selection-bar';
  const hint = document.createElement('span'); hint.textContent = 'Tap the selection for options, or hold a word to select again.';
  const done = document.createElement('button'); done.type = 'button'; done.textContent = 'Done';
  done.className = 'text-button'; done.setAttribute('aria-label', 'Done selecting');
  const output = document.createElement('pre'); output.tabIndex = -1;
  bar.append(hint, done); view.append(bar, output); display.append(view);
  const events = new AbortController(), { signal } = events;
  let pressedText: string | undefined;

  const selectedText = () => {
    const selection = document.getSelection(), node = output.firstChild;
    if (!node || !selection?.rangeCount || selection.isCollapsed) return '';
    const range = selection.getRangeAt(0);
    if (!range.intersectsNode(node)) return '';
    const start = range.startContainer === node ? range.startOffset : 0;
    const end = range.endContainer === node ? range.endOffset : undefined;
    return node.textContent!.slice(start, end);
  };
  const close = (focus = false) => {
    if (view.hidden) return;
    const selection = document.getSelection();
    if (selection?.rangeCount && selection.getRangeAt(0).intersectsNode(output)) selection.removeAllRanges();
    view.hidden = true; output.replaceChildren(); host.inert = false; pressedText = undefined;
    terminal.clearSelection();
    if (focus) copy.focus({ preventScroll: true });
  };
  done.onclick = () => close(true);
  pane.addEventListener('keydown', event => {
    if (!view.hidden && event.key === 'Escape' && !pane.querySelector('dialog[open]')) {
      event.preventDefault(); close(true);
    }
  }, { signal });
  // Capture before a toolbar tap can collapse WebKit's document selection.
  pane.addEventListener('pointerdown', event => {
    pressedText = !view.hidden && copy.contains(event.target as Node) ? selectedText() : undefined;
  }, { capture: true, signal });
  copy.addEventListener('pointercancel', () => { pressedText = undefined; }, { signal });
  copy.addEventListener('mousedown', event => { if (!view.hidden) event.preventDefault(); }, { signal });
  pane.addEventListener('click', event => {
    if (event.target instanceof Element && event.target.closest('.terminal-toolbar button, .terminal-session button') && !copy.contains(event.target)) close();
  }, { capture: true, signal });
  return {
    open() {
      const position = terminal.getSelectionPosition(), selection = document.getSelection();
      if (!position || !selection || !view.hidden) return;
      const { text, start, end } = terminalSnapshot(terminal, position);
      if (start >= end) return;
      // xterm replaces rendered rows. Give Safari one stable, noneditable text node outside its touch handlers.
      const node = document.createTextNode(text);
      output.replaceChildren(node);
      terminal.blur(); host.inert = true; view.hidden = false;
      output.focus({ preventScroll: true });
      const range = document.createRange(); range.setStart(node, start); range.setEnd(node, end);
      selection.removeAllRanges(); selection.addRange(range);
      const first = range.getClientRects()[0];
      if (first) output.scrollTop += first.top - output.getBoundingClientRect().top - output.clientHeight / 3;
    },
    copyText() {
      if (view.hidden) return undefined;
      const text = pressedText ?? selectedText();
      pressedText = undefined; return text;
    },
    close,
    dispose() { close(); events.abort(); },
  };
}
