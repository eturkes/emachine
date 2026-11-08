import { createContextMenu } from './context-menu';

// Keep gesture state on the mounted tab so inventory updates cannot interrupt a press.
export function attachSessionTabActions(tab: HTMLButtonElement, edit: () => void, closeTab: () => void): () => void {
  let press: { id: number; x: number; y: number; timer: number } | undefined;
  let releaseClick: AbortController | undefined;
  let menu: ReturnType<typeof createContextMenu> | undefined;
  const open = (x?: number, y?: number) => {
    if (!menu) {
      menu = createContextMenu(`Tab actions for ${tab.textContent}`, () => tab.focus({ preventScroll: true }), tab);
      menu.element.classList.add('tab-menu');
      menu.item('Choose zmx session', edit);
      menu.item('Close tab', closeTab);
      document.body.append(menu.element);
    }
    if (!menu.element.hidden) return;
    const bounds = tab.getBoundingClientRect();
    menu.open(x ?? bounds.left, y ?? bounds.bottom);
  };
  const suppressReleaseClick = () => {
    releaseClick?.abort();
    const controller = new AbortController(); releaseClick = controller;
    const clear = () => { controller.abort(); if (releaseClick === controller) releaseClick = undefined; };
    // A held finger can release over the new menu. Suppress only that release.
    document.addEventListener('pointerdown', clear, { capture: true, once: true, signal: controller.signal });
    // Touch compatibility mousedown would refocus the tab and dismiss the menu before click.
    document.addEventListener('mousedown', event => event.preventDefault(), { capture: true, once: true, signal: controller.signal });
    document.addEventListener('click', event => {
      if (event.detail > 0) { event.preventDefault(); event.stopImmediatePropagation(); }
      clear();
    }, { capture: true, once: true, signal: controller.signal });
  };
  const cancel = () => {
    if (press) window.clearTimeout(press.timer);
    press = undefined;
  };
  const down = (event: PointerEvent) => {
    cancel();
    if (event.pointerType === 'mouse' || !event.isPrimary || event.button !== 0) return;
    press = { id: event.pointerId, x: event.clientX, y: event.clientY, timer: window.setTimeout(() => {
      press = undefined;
      if (!tab.isConnected || document.hidden) return;
      suppressReleaseClick(); open();
    }, 550) };
  };
  const move = (event: PointerEvent) => {
    if (press && (event.pointerId !== press.id || Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10)) cancel();
  };
  const doubleClick = (event: MouseEvent) => { cancel(); event.preventDefault(); open(); };
  const contextMenu = (event: MouseEvent) => {
    event.preventDefault();
    const touch = press || releaseClick;
    cancel(); suppressReleaseClick();
    if (!touch && (event.clientX || event.clientY)) open(event.clientX, event.clientY);
    else open();
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === 'F2') { event.preventDefault(); edit(); }
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault(); if (!event.repeat) open();
    }
  };
  tab.addEventListener('pointerdown', down);
  tab.addEventListener('pointermove', move);
  tab.addEventListener('pointerup', cancel);
  tab.addEventListener('pointercancel', cancel);
  tab.addEventListener('pointerleave', cancel);
  tab.addEventListener('lostpointercapture', cancel);
  tab.addEventListener('dblclick', doubleClick);
  tab.addEventListener('contextmenu', contextMenu);
  tab.addEventListener('keydown', key);
  window.addEventListener('blur', cancel);
  document.addEventListener('visibilitychange', cancel);
  return () => {
    cancel(); releaseClick?.abort(); menu?.dispose();
    tab.removeEventListener('pointerdown', down);
    tab.removeEventListener('pointermove', move);
    tab.removeEventListener('pointerup', cancel);
    tab.removeEventListener('pointercancel', cancel);
    tab.removeEventListener('pointerleave', cancel);
    tab.removeEventListener('lostpointercapture', cancel);
    tab.removeEventListener('dblclick', doubleClick);
    tab.removeEventListener('contextmenu', contextMenu);
    tab.removeEventListener('keydown', key);
    window.removeEventListener('blur', cancel);
    document.removeEventListener('visibilitychange', cancel);
  };
}
