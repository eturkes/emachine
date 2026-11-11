export function attachTerminalToolbar(toolbar: HTMLElement, groups: HTMLElement[], keyboard: HTMLElement): () => void {
  const keys = toolbar.querySelector<HTMLElement>('.terminal-keys')!;
  const tools = toolbar.querySelector<HTMLElement>('.terminal-tools')!;
  const lineBreak = document.createElement('span');
  lineBreak.className = 'terminal-toolbar-break'; lineBreak.hidden = true;
  lineBreak.setAttribute('aria-hidden', 'true');
  toolbar.dataset.layout = 'compact';
  let disposed = false;
  const layout = () => {
    if (disposed || !toolbar.clientWidth) return;
    const style = getComputedStyle(toolbar);
    const gap = parseFloat(style.getPropertyValue('--terminal-section-gap'));
    const inset = parseFloat(style.getPropertyValue('--terminal-toolbar-inset'));
    const available = toolbar.clientWidth - 2 * inset;
    // Measure buttons, not wrappers: compact scrolling and expanded rows have different padding.
    const widths = groups.map(group => {
      const buttons = Array.from(group.querySelectorAll('button')).map(button => button.getBoundingClientRect().width).filter(width => width > 0);
      return buttons.reduce((sum, width) => sum + width, 0) + Math.max(0, buttons.length - 1) * parseFloat(getComputedStyle(group).columnGap);
    });
    const keyboardWidth = keyboard.getBoundingClientRect().width;
    if (keyboardWidth) widths[0] += keyboardWidth + gap;
    const rowWidth = (start: number, end: number) => widths.slice(start, end).reduce((sum, width) => sum + width, 0) + (end - start - 1) * gap;
    let mode = 'single';
    let split = 0;
    if (rowWidth(0, groups.length) > available) {
      mode = 'compact';
      let balance = Infinity;
      for (let index = 1; index < groups.length; index++) {
        const first = rowWidth(0, index), second = rowWidth(index, groups.length);
        if (Math.max(first, second) <= available && Math.abs(first - second) < balance) {
          mode = 'wrapped'; split = index; balance = Math.abs(first - second);
        }
      }
    }
    if (mode !== 'compact') { keys.scrollLeft = 0; tools.scrollLeft = 0; }
    toolbar.dataset.layout = mode;
    lineBreak.hidden = mode !== 'wrapped';
    if (split && lineBreak.nextSibling !== groups[split]) groups[split].before(lineBreak);
    if (mode === 'compact') return;
    // Keep native selection's Copy/Paste/Done bar over first-row keys, clear of the other tools.
    const bounds = toolbar.getBoundingClientRect();
    const first = groups[0].getBoundingClientRect();
    const rowKeys = groups.slice(0, 3).map(group => group.getBoundingClientRect()).filter(rect => Math.abs(rect.top - first.top) < 1);
    toolbar.style.setProperty('--terminal-selection-width', `${Math.max(...rowKeys.map(rect => rect.right)) - bounds.left - inset}px`);
    toolbar.style.setProperty('--terminal-row-height', `${first.height}px`);
  };
  // Measure before paint; deferring a narrow resize by a frame briefly exposes extra rows.
  const observer = new ResizeObserver(layout);
  observer.observe(toolbar.parentElement!);
  observer.observe(keyboard);
  for (const group of groups) for (const button of group.querySelectorAll('button')) observer.observe(button);
  window.addEventListener('resize', layout);
  void document.fonts.ready.then(layout);
  layout();
  return () => {
    disposed = true; observer.disconnect(); window.removeEventListener('resize', layout); lineBreak.remove();
  };
}
