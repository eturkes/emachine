export function createContextMenu(label: string, restoreFocus: () => void, trigger?: HTMLElement) {
  const element = document.createElement('div');
  element.className = 'context-menu'; element.hidden = true;
  element.setAttribute('role', 'menu'); element.setAttribute('aria-label', label);
  const items: { button: HTMLButtonElement; enabled(): boolean }[] = [];
  let opened: AbortController | undefined;
  const close = (focus = false) => {
    if (element.hidden) return;
    opened?.abort(); opened = undefined; element.hidden = true;
    trigger?.setAttribute('aria-expanded', 'false');
    if (focus) restoreFocus();
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
    items.push({ button, enabled }); element.append(button);
  };
  const open = (x: number, y: number) => {
    close();
    for (const item of items) item.button.disabled = !item.enabled();
    element.hidden = false; trigger?.setAttribute('aria-expanded', 'true');
    const bounds = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(x, innerWidth - bounds.width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(y, innerHeight - bounds.height - 8))}px`;
    items.find(item => !item.button.disabled)?.button.focus({ preventScroll: true });
    opened = new AbortController();
    const { signal } = opened;
    const outside = (event: Event) => { if (!element.contains(event.target as Node)) close(); };
    document.addEventListener('pointerdown', outside, { capture: true, signal });
    document.addEventListener('focusin', outside, { signal });
    document.addEventListener('scroll', outside, { capture: true, signal });
    window.addEventListener('resize', () => close(), { signal });
    window.addEventListener('blur', () => close(), { signal });
  };
  element.addEventListener('contextmenu', event => event.preventDefault());
  element.addEventListener('keydown', event => {
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
  return { element, item, open, close, dispose() { close(); element.remove(); } };
}
