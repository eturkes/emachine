import type { Terminal } from '@xterm/xterm';
import { createContextMenu } from './context-menu';

type ClipboardActions = { copy(): void; paste(): void; canPaste(): boolean; closeTab?(): void };

export function attachTerminalClipboard(host: HTMLElement, terminal: Terminal, actions: ClipboardActions): { close(): void; dispose(): void } {
  const lifetime = new AbortController();
  const menu = createContextMenu('Terminal actions', () => terminal.focus());
  host.after(menu.element);
  menu.item('Copy', actions.copy, () => terminal.hasSelection(), 'Control+Shift+C');
  menu.item('Paste', actions.paste, actions.canPaste, 'Control+Shift+V');
  menu.item('Select all', () => terminal.selectAll());
  menu.item('Clear selection', () => terminal.clearSelection(), () => terminal.hasSelection());
  if (actions.closeTab) menu.item('Close tab', actions.closeTab);
  const openAtCursor = () => {
    const bounds = (terminal.textarea ?? host).getBoundingClientRect();
    menu.open(bounds.left, bounds.bottom);
  };
  const handleKey = (event: KeyboardEvent): boolean => {
    if (event.isComposing) return true;
    const key = event.key.toLowerCase();
    const clipboard = event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && (key === 'c' || key === 'v');
    const context = !event.ctrlKey && !event.altKey && !event.metaKey && (key === 'contextmenu' || event.shiftKey && key === 'f10');
    if (!clipboard && !context) return true;
    // Returning false bypasses xterm; cancel the browser default too, especially native paste.
    event.preventDefault(); event.stopPropagation();
    if (event.type === 'keydown' && !event.repeat) {
      if (context) openAtCursor();
      else { menu.close(true); if (key === 'c') actions.copy(); else actions.paste(); }
    }
    return false;
  };
  terminal.attachCustomKeyEventHandler(handleKey);
  menu.element.addEventListener('keydown', handleKey);
  // Intercept before xterm moves its hidden textarea or sends right-button mouse reports to a TUI.
  let finger = false;
  host.addEventListener('pointerdown', event => { finger = event.pointerType === 'touch'; }, { capture: true, signal: lifetime.signal });
  for (const type of ['mousedown', 'mouseup', 'auxclick'] as const) host.addEventListener(type, event => {
    if (event.button === 2) { event.preventDefault(); event.stopPropagation(); }
  }, { capture: true, signal: lifetime.signal });
  host.addEventListener('contextmenu', event => {
    event.preventDefault(); event.stopPropagation();
    // A finger hold on the grid belongs to touch selection, even if the browser sends contextmenu first.
    if (finger && terminal.modes.mouseTrackingMode === 'none' && event.target instanceof Element && event.target.closest('.xterm-screen')) return;
    if (event.clientX || event.clientY) menu.open(event.clientX, event.clientY);
    else openAtCursor();
  }, { capture: true, signal: lifetime.signal });
  return {
    close: menu.close,
    dispose() { menu.dispose(); lifetime.abort(); terminal.attachCustomKeyEventHandler(() => true); },
  };
}
