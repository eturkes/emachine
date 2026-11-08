import type { IBufferCell, IBufferLine } from '@xterm/xterm';

export function selectionRow(
  line: IBufferLine, text: string, spans: HTMLSpanElement[], cell: IBufferCell,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'terminal-native-row';
  row.append(...spans);
  if (row.textContent === text) return row;

  let column = 0;
  let offset = 0;
  for (const span of spans) {
    const ink = span.textContent ?? '';
    const start = offset;
    // Invisible glyphs occupy one rendered space even when their buffer text
    // contains several UTF-16 units. A wide glyph's continuation has no text.
    for (let painted = 0; painted < ink.length && column < line.length;) {
      const current = line.getCell(column++, cell);
      if (!current || !current.getWidth()) continue;
      const length = current.getChars().length || 1;
      offset += length;
      painted += current.isInvisible() ? 1 : length;
    }

    const original = text.slice(start, offset);
    if (original === ink) continue;
    if (ink.startsWith(original)) {
      span.textContent = original;
      span.dataset.terminalPadding = ink.slice(original.length);
    } else {
      const bytes = document.createElement('samp');
      bytes.className = 'terminal-native-bytes';
      bytes.textContent = original;
      span.dataset.terminalInk = ink;
      span.replaceChildren(bytes);
    }
  }
  return row;
}
