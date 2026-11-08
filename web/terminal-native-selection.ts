import type { Terminal } from '@xterm/xterm';
import { snapshotGrid } from './terminal-snapshot-grid';
import { selectionPages, textPoint } from './terminal-selection-pages';

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
  // Use the keyboard control strip for Done so the frozen grid keeps its entire viewport.
  const keys = pane.querySelector<HTMLElement>('.terminal-keyboard-controls')!;
  bar.hidden = true; bar.append(hint, done); keys.after(bar);
  view.append(output); display.append(view);
  const events = new AbortController(), { signal } = events;
  let pressedText: string | undefined;
  let snapshot: { grid: NonNullable<ReturnType<typeof snapshotGrid>>; pages: ReturnType<typeof selectionPages> } | undefined;
  const paintViewport = () => {
    if (!snapshot) return;
    const { grid, pages } = snapshot;
    pages.paintAround(Math.floor(output.scrollTop / grid.rowHeight), Math.ceil(output.clientHeight / grid.rowHeight));
  };
  output.addEventListener('scroll', paintViewport, { passive: true, signal });
  const resize = new ResizeObserver(paintViewport);

  const selectedText = () => {
    const selection = document.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return '';
    const range = selection.getRangeAt(0).cloneRange();
    if (!range.intersectsNode(output)) return '';
    const bounds = document.createRange(); bounds.selectNodeContents(output);
    if (range.compareBoundaryPoints(Range.START_TO_START, bounds) < 0) range.setStart(output, 0);
    if (range.compareBoundaryPoints(Range.END_TO_END, bounds) > 0) range.setEnd(output, output.childNodes.length);
    return range.toString();
  };
  const close = (focus = false) => {
    if (view.hidden) return;
    const selection = document.getSelection();
    if (selection?.rangeCount && selection.getRangeAt(0).intersectsNode(output)) selection.removeAllRanges();
    view.hidden = bar.hidden = true; output.replaceChildren(); view.querySelector('style')?.remove();
    resize.disconnect(); snapshot?.grid.dispose(); snapshot = undefined;
    keys.inert = host.inert = false; pressedText = undefined;
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
    if (event.target instanceof Element && event.target.closest('.terminal-toolbar button, .terminal-session button') && !bar.contains(event.target) && !copy.contains(event.target)) close();
  }, { capture: true, signal });
  return {
    open() {
      const position = terminal.getSelectionPosition(), selection = document.getSelection();
      if (!position || !selection || !view.hidden) return;
      const grid = snapshotGrid(terminal, host);
      if (!grid) return;
      const buffer = terminal.buffer.active, viewportY = buffer.viewportY;
      const pages = selectionPages(grid, buffer.getNullCell());
      const start = pages.offsetAt(position.start.y, position.start.x), end = pages.offsetAt(position.end.y, position.end.x);
      if (start >= end) { grid.dispose(); return; }
      const visibleRows = Math.ceil(host.clientHeight / grid.rowHeight);
      pages.paintAround(viewportY, visibleRows);
      pages.element.style.paddingBottom = Math.max(0, host.clientHeight - terminal.rows * grid.rowHeight) + 'px';
      snapshot = { grid, pages };
      output.className = grid.ownerClass; output.style.backgroundColor = grid.background;
      view.prepend(grid.css); output.replaceChildren(pages.element);
      terminal.blur(); host.inert = keys.inert = true; view.hidden = bar.hidden = false;
      output.focus({ preventScroll: true });
      const range = document.createRange();
      range.setStart(...textPoint(output, start, false)); range.setEnd(...textPoint(output, end, true));
      selection.removeAllRanges(); selection.addRange(range);
      output.scrollTop = viewportY * grid.rowHeight + grid.scrollOffsetY;
      output.scrollLeft = grid.scrollLeft;
      resize.observe(output);
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
