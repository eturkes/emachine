import type { Terminal } from '@xterm/xterm';

export function attachTerminalTouchScroll(host: HTMLElement, terminal: Terminal): () => void {
  const screen = host.querySelector<HTMLElement>('.xterm-screen')!;
  const listeners = new AbortController();
  const { signal } = listeners;
  let gesture: { id: number; x: number; y: number; lastY: number; remainder: number; vertical: boolean } | undefined;
  const reset = () => { gesture = undefined; };
  host.addEventListener('touchstart', event => {
    reset();
    if (event.touches.length !== 1 || event.target instanceof Element && event.target.closest('.scrollbar')) return;
    const touch = event.touches[0];
    gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, lastY: touch.clientY, remainder: 0, vertical: false };
  }, { passive: true, signal });
  host.addEventListener('touchmove', event => {
    if (!gesture || event.touches.length !== 1 || event.touches[0].identifier !== gesture.id) { reset(); return; }
    const touch = event.touches[0];
    if (!gesture.vertical) {
      const dx = Math.abs(touch.clientX - gesture.x), dy = Math.abs(touch.clientY - gesture.y);
      if (Math.max(dx, dy) < 6) return;
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
  host.addEventListener('touchend', reset, { passive: true, signal });
  host.addEventListener('touchcancel', reset, { passive: true, signal });
  return () => { reset(); listeners.abort(); };
}
