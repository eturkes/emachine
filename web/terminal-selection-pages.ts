import type { IBufferCell } from '@xterm/xterm';
import { selectionRow } from './terminal-selection-row';
import type { snapshotGrid } from './terminal-snapshot-grid';

const pageSize = 64;

// At a run boundary a selection's start belongs with the following glyph,
// while its end belongs with the preceding glyph.
export function textPoint(root: Node, offset: number, preferEnd: boolean): [Node, number] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let previous: Text | undefined;
  for (let child = walker.nextNode(); child; child = walker.nextNode()) {
    const node = child as Text;
    if (!node.length) continue;
    if (offset < node.length || (preferEnd && offset === node.length)) return [node, offset];
    offset -= node.length;
    previous = node;
  }
  return previous ? [previous, previous.length] : [root, 0];
}

export function selectionPages(grid: NonNullable<ReturnType<typeof snapshotGrid>>, cell: IBufferCell) {
  const element = document.createElement('div');
  element.className = grid.rowsClass;
  element.style.width = grid.width + 'px';
  element.style.lineHeight = grid.rowHeight + 'px';
  element.style.letterSpacing = grid.letterSpacing;
  element.style.whiteSpace = 'pre-wrap';

  const rows: { text: string; start: number; hardBreak: boolean }[] = [];
  let length = 0, lastOutput = 0;
  for (let row = 0; row < grid.length; row++) {
    const line = grid.line(row);
    if (row && !line.isWrapped) {
      rows[row - 1].hardBreak = true;
      length++;
    }
    const text = line.translateToString(true);
    rows.push({ text, start: length, hardBreak: false });
    length += text.length;
    if (text) lastOutput = length;
  }
  const hasBreak = (row: typeof rows[number]) => row.hardBreak && row.start + row.text.length < lastOutput;
  const pages: HTMLElement[] = [];
  for (let first = 0; first < rows.length; first += pageSize) {
    const group = rows.slice(first, first + pageSize);
    const page = document.createElement('div');
    page.className = 'terminal-native-page terminal-native-placeholder';
    page.style.height = group.length * grid.rowHeight + 'px';
    page.append(document.createTextNode(group.map(row => row.text + (hasBreak(row) ? '\n' : '')).join('')));
    pages.push(page);
    element.append(page);
  }

  function paint(index: number) {
    const page = pages[index], placeholder = page.firstChild;
    if (!(placeholder instanceof Text)) return;
    const fragment = document.createDocumentFragment();
    for (let y = index * pageSize; y < Math.min((index + 1) * pageSize, rows.length); y++) {
      const row = selectionRow(grid.line(y), rows[y].text, grid.paint(y), cell);
      if (hasBreak(rows[y])) row.append('\n');
      fragment.append(row);
    }

    const selection = document.getSelection();
    const anchor = selection?.anchorNode, focus = selection?.focusNode;
    // A native Select All or a handle dragged into scrollback may have an
    // endpoint inside the one text node we're about to replace.
    const localOffset = (node: Node | null, offset: number) =>
      node === placeholder ? offset : node === page ? (offset ? placeholder.length : 0) : undefined;
    let restore: (() => void) | undefined;
    if (selection?.rangeCount && anchor && focus) {
      const a = selection.anchorOffset, f = selection.focusOffset;
      const start = localOffset(anchor, a), end = localOffset(focus, f);
      if (start !== undefined || end !== undefined) {
        const range = selection.getRangeAt(0);
        const reverse = range.endContainer === anchor && range.endOffset === a && !selection.isCollapsed;
        const forward = !reverse && !selection.isCollapsed;
        restore = () => {
          const [base, baseOffset]: [Node, number] = start === undefined ? [anchor, a] : textPoint(page, start, reverse);
          const [extent, extentOffset]: [Node, number] = end === undefined ? [focus, f] : textPoint(page, end, forward);
          selection.setBaseAndExtent(base, baseOffset, extent, extentOffset);
        };
      }
    }
    page.replaceChildren(fragment);
    page.classList.remove('terminal-native-placeholder');
    restore?.();
  }

  return {
    element,
    offsetAt(row: number, column: number) {
      if (row < 0) return 0;
      if (row >= rows.length) return lastOutput;
      return Math.min(lastOutput, rows[row].start + grid.line(row).translateToString(true, 0, column).length);
    },
    paintAround(row: number, visibleRows: number) {
      const first = Math.max(0, Math.floor(row / pageSize) - 1);
      const last = Math.min(pages.length - 1, Math.floor((row + visibleRows - 1) / pageSize) + 1);
      for (let i = first; i <= last; i++) paint(i);
    },
  };
}
