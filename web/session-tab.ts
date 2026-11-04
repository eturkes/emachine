// Keep gesture state on the mounted tab so inventory updates cannot interrupt a press.
export function attachSessionTabEditor(tab: HTMLButtonElement, edit: () => void): () => void {
  let press: { id: number; x: number; y: number; timer: number } | undefined;
  let releaseClick: AbortController | undefined;
  const suppressReleaseClick = () => {
    releaseClick?.abort();
    const controller = new AbortController(); releaseClick = controller;
    const clear = () => { controller.abort(); if (releaseClick === controller) releaseClick = undefined; };
    // A modal can retarget the held finger's click to its backdrop. Only swallow
    // that release; a new pointer press or a keyboard activation is intentional.
    document.addEventListener('pointerdown', clear, { capture: true, once: true, signal: controller.signal });
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
      suppressReleaseClick(); edit();
    }, 550) };
  };
  const move = (event: PointerEvent) => {
    if (press && (event.pointerId !== press.id || Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10)) cancel();
  };
  const doubleClick = (event: MouseEvent) => { cancel(); event.preventDefault(); edit(); };
  const contextMenu = (event: MouseEvent) => { cancel(); event.preventDefault(); suppressReleaseClick(); edit(); };
  const key = (event: KeyboardEvent) => {
    if (event.key === 'F2') { event.preventDefault(); edit(); }
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
    cancel(); releaseClick?.abort();
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
