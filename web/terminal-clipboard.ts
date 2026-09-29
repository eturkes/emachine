import type { Terminal } from '@xterm/xterm';

type ClipboardActions = { copy(): void; paste(): void; canPaste(): boolean };

export function attachTerminalClipboard(host: HTMLElement, terminal: Terminal, actions: ClipboardActions): { close(): void; dispose(): void } {
  const lifetime = new AbortController();
  let opened: AbortController | undefined;
  const menu = document.createElement('div');
  menu.className = 'terminal-menu'; menu.hidden = true;
  menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'Terminal actions');
  host.after(menu);
  const items: { button: HTMLButtonElement; enabled(): boolean }[] = [];
  const close = (focus = false) => {
    if (menu.hidden) return;
    opened?.abort(); opened = undefined; menu.hidden = true;
    if (focus) terminal.focus();
  };
  const item = (label: string, action: () => void, enabled = () => true, shortcut = '') => {
    const button = document.createElement('button');
    button.type = 'button'; button.tabIndex = -1; button.textContent = label;
    button.setAttribute('role', 'menuitem'); button.setAttribute('aria-label', label);
    if (shortcut) {
      button.setAttribute('aria-keyshortcuts', shortcut);
      const hint = document.createElement('span'); hint.textContent = shortcut.replace('Control', 'Ctrl'); hint.setAttribute('aria-hidden', 'true'); button.append(hint);
    }
    button.onclick = () => { close(true); action(); };
    items.push({ button, enabled }); menu.append(button);
  };
  item('Copy', actions.copy, () => terminal.hasSelection(), 'Control+Shift+C');
  item('Paste', actions.paste, actions.canPaste, 'Control+Shift+V');
  item('Select all', () => terminal.selectAll());
  item('Clear selection', () => terminal.clearSelection(), () => terminal.hasSelection());
  const open = (x: number, y: number) => {
    close();
    for (const item of items) item.button.disabled = !item.enabled();
    menu.hidden = false;
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, innerWidth - bounds.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, innerHeight - bounds.height - 8))}px`;
    items.find(item => !item.button.disabled)?.button.focus({ preventScroll: true });
    opened = new AbortController();
    const { signal } = opened;
    document.addEventListener('pointerdown', event => { if (!menu.contains(event.target as Node)) close(); }, { capture: true, signal });
    document.addEventListener('focusin', event => { if (!menu.contains(event.target as Node)) close(); }, { signal });
    document.addEventListener('scroll', event => { if (!menu.contains(event.target as Node)) close(); }, { capture: true, signal });
    window.addEventListener('resize', () => close(), { signal });
    window.addEventListener('blur', () => close(), { signal });
  };
  const openAtCursor = () => {
    const bounds = (terminal.textarea ?? host).getBoundingClientRect();
    open(bounds.left, bounds.bottom);
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
      else { close(true); if (key === 'c') actions.copy(); else actions.paste(); }
    }
    return false;
  };
  terminal.attachCustomKeyEventHandler(handleKey);
  menu.addEventListener('keydown', event => {
    if (!handleKey(event)) return;
    if (event.key === 'Tab') { close(true); return; }
    if (!['Escape', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'Escape') { close(true); return; }
    const enabled = items.map(item => item.button).filter(button => !button.disabled);
    const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 :
      (index + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length;
    enabled[next]?.focus();
  });
  // Intercept before xterm moves its hidden textarea or sends right-button mouse reports to a TUI.
  for (const type of ['mousedown', 'mouseup', 'auxclick'] as const) host.addEventListener(type, event => {
    if (event.button === 2) { event.preventDefault(); event.stopPropagation(); }
  }, { capture: true, signal: lifetime.signal });
  host.addEventListener('contextmenu', event => {
    event.preventDefault(); event.stopPropagation();
    if (event.clientX || event.clientY) open(event.clientX, event.clientY);
    else openAtCursor();
  }, { capture: true, signal: lifetime.signal });
  return {
    close,
    dispose() { close(); lifetime.abort(); terminal.attachCustomKeyEventHandler(() => true); menu.remove(); },
  };
}
