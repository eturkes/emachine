import type { IMarker, Terminal } from '@xterm/xterm';

// Use buffer cells, not DOM character offsets: one glyph can span columns or contain several code points.
function touchedRange(terminal: Terminal, screen: HTMLElement, x: number, y: number, word: boolean) {
  const bounds = screen.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  const { cols, rows } = terminal, buffer = terminal.buffer.active;
  const col = Math.max(0, Math.min(cols - 1, Math.floor((x - bounds.left) * cols / bounds.width)));
  const row = buffer.viewportY + Math.max(0, Math.min(rows - 1, Math.floor((y - bounds.top) * rows / bounds.height)));
  const cell = buffer.getNullCell();
  const at = (index: number) => buffer.getLine(Math.floor(index / cols))?.getCell(index % cols, cell);
  let start = row * cols + col;
  if (col > 0 && at(start)?.getWidth() === 0) start--;
  let end = start + (at(start)?.getWidth() || 1);
  if (word) {
    const joinsPrevious = (index: number) => index % cols !== 0 || buffer.getLine(Math.floor(index / cols))?.isWrapped;
    const isWordCell = (index: number) => {
      const value = at(index);
      if (!value) return false;
      if (value.getWidth() === 0) return true;
      const chars = value.getChars();
      if (chars) return !terminal.options.wordSeparator?.includes(chars);
      // A wide glyph wraps early when only one column remains. Its unprinted pad is not a space.
      return index % cols === cols - 1 && joinsPrevious(index + 1) && at(index + 1)?.getWidth() === 2;
    };
    if (isWordCell(start)) {
      while (start > 0 && joinsPrevious(start) && isWordCell(start - 1)) start--;
      while (joinsPrevious(end) && isWordCell(end)) end++;
    }
  }
  return { start, end };
}

export function attachTerminalTouchScroll(host: HTMLElement, terminal: Terminal): () => void {
  const screen = host.querySelector<HTMLElement>('.xterm-screen')!;
  const listeners = new AbortController();
  const { signal } = listeners;
  let gesture: { id: number; x: number; y: number; lastY: number; remainder: number; vertical: boolean; started: number } | undefined;
  let hold: number | undefined;
  let anchor: { marker: IMarker; column: number; length: number } | undefined;
  const reset = () => {
    window.clearTimeout(hold); gesture = undefined;
    anchor?.marker.dispose(); anchor = undefined;
  };
  const select = (start: number, end: number) => terminal.select(start % terminal.cols, Math.floor(start / terminal.cols), end - start);
  let finger = false;
  screen.addEventListener('pointerdown', event => { finger = event.pointerType === 'touch'; }, { signal });
  screen.addEventListener('mousedown', event => {
    // Single taps activate links and clear selections. xterm selects words or lines on repeated clicks.
    if (finger && event.button === 0 && event.detail > 1 && terminal.modes.mouseTrackingMode === 'none') {
      event.preventDefault();
      event.stopPropagation();
    }
  }, { signal });
  host.addEventListener('touchstart', event => {
    reset();
    if (event.touches.length !== 1 || event.target instanceof Element && event.target.closest('.scrollbar')) return;
    const touch = event.touches[0];
    gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, lastY: touch.clientY, remainder: 0, vertical: false, started: event.timeStamp };
    if (screen.contains(event.target as Node) && terminal.modes.mouseTrackingMode === 'none') {
      hold = window.setTimeout(() => {
        if (!gesture || document.hidden || terminal.modes.mouseTrackingMode !== 'none') return;
        const range = touchedRange(terminal, screen, gesture.x, gesture.y, true);
        if (!range) return;
        // Track the held word as incoming output trims scrollback during a drag.
        const { baseY, cursorY } = terminal.buffer.active;
        const marker = terminal.registerMarker(Math.floor(range.start / terminal.cols) - baseY - cursorY);
        anchor = { marker, column: range.start % terminal.cols, length: range.end - range.start };
        select(range.start, range.end);
      }, 550);
    }
  }, { passive: true, signal });
  host.addEventListener('touchmove', event => {
    if (!gesture || event.touches.length !== 1 || event.touches[0].identifier !== gesture.id) { reset(); return; }
    const touch = event.touches[0];
    if (anchor) {
      if (!event.cancelable) { reset(); return; }
      event.preventDefault();
      if (anchor.marker.isDisposed || terminal.modes.mouseTrackingMode !== 'none') return;
      const start = anchor.marker.line * terminal.cols + anchor.column;
      const target = touchedRange(terminal, screen, touch.clientX, touch.clientY, false);
      if (target) select(Math.min(start, target.start), Math.max(start + anchor.length, target.end));
      return;
    }
    if (!gesture.vertical) {
      const dx = Math.abs(touch.clientX - gesture.x), dy = Math.abs(touch.clientY - gesture.y);
      if (Math.max(dx, dy) < 6) return;
      window.clearTimeout(hold);
      if (dx > dy) { reset(); return; }
      gesture.vertical = true;
    }
    if (!event.cancelable) { reset(); return; }
    // xterm 6's virtual scrollbar handles wheels, not touch; contain swipes even at either boundary.
    event.preventDefault();
    const bounds = screen.getBoundingClientRect(), rowHeight = bounds.height / terminal.rows;
    if (rowHeight <= 0) return;
    gesture.remainder += gesture.lastY - touch.clientY;
    gesture.lastY = touch.clientY;
    const lines = Math.trunc(gesture.remainder / rowHeight);
    gesture.remainder -= lines * rowHeight;
    if (!lines) return;
    if (terminal.buffer.active.type === 'normal' && terminal.modes.mouseTrackingMode === 'none') {
      terminal.scrollLines(lines);
    } else {
      // Let xterm encode application-cursor and mouse protocols; each wheel event represents one row.
      for (let i = 0; i < Math.abs(lines); i++) screen.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, deltaMode: WheelEvent.DOM_DELTA_LINE, deltaY: Math.sign(lines),
        clientX: Math.max(bounds.left, Math.min(bounds.right - 1, touch.clientX)),
        clientY: Math.max(bounds.top, Math.min(bounds.bottom - 1, touch.clientY)),
      }));
    }
  }, { passive: false, signal });
  host.addEventListener('touchend', event => {
    // Suppress the compatibility click that would clear the selection and reopen the keyboard.
    if (anchor && event.cancelable) { event.preventDefault(); reset(); return; }
    const tap = gesture; reset();
    if (!tap || tap.vertical || event.defaultPrevented || event.touches.length || event.timeStamp - tap.started > 400) return;
    const touch = Array.from(event.changedTouches).find(touch => touch.identifier === tap.id);
    if (!touch || Math.max(Math.abs(touch.clientX - tap.x), Math.abs(touch.clientY - tap.y)) >= 6) return;
    // Focus within the real touch gesture so iOS can open its software keyboard.
    terminal.focus();
  }, { passive: false, signal });
  host.addEventListener('touchcancel', reset, { passive: true, signal });
  window.addEventListener('blur', reset, { signal });
  document.addEventListener('visibilitychange', reset, { signal });
  const resize = terminal.onResize(reset), buffer = terminal.buffer.onBufferChange(reset);
  return () => { reset(); listeners.abort(); resize.dispose(); buffer.dispose(); };
}
