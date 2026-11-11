import type { ITerminalAddon, Terminal } from '@xterm/xterm';

type Rectangle = [x: number, y: number, width: number, height: number];
const blocks = new Map<number, Rectangle[]>([
  [0x2580, [[0, 0, 8, 4]]],
  [0x2590, [[4, 0, 4, 8]]],
  [0x2594, [[0, 0, 8, 1]]],
  [0x2595, [[7, 0, 1, 8]]],
]);
for (let eighths = 1; eighths <= 8; eighths++) blocks.set(0x2580 + eighths, [[0, 8 - eighths, 8, eighths]]);
for (let eighths = 1; eighths <= 7; eighths++) blocks.set(0x2590 - eighths, [[0, 0, eighths, 8]]);
// Quadrant bits: top left, top right, bottom left, bottom right.
[4, 8, 1, 13, 9, 7, 11, 2, 6, 14].forEach((mask, index) => {
  blocks.set(0x2596 + index, [0, 1, 2, 3].filter(bit => mask & (1 << bit))
    .map(bit => [bit % 2 * 4, Math.floor(bit / 2) * 4, 4, 4]));
});
// Leave shades and combined glyphs to the text renderer.
const blockRun = /((?:[\u2580-\u2590\u2594-\u259f](?!\p{Mark}))+)/u;

function paintBlocks(spans: HTMLSpanElement[], cellWidth: number): HTMLSpanElement[] {
  return spans.flatMap(span => {
    const text = span.textContent ?? '';
    if (!blockRun.test(text)) return [span];
    return text.split(blockRun).flatMap((run, index) => {
      if (!run) return [];
      const part = span.cloneNode(false) as HTMLSpanElement;
      part.textContent = run;
      if (index % 2 === 1) {
        part.classList.add('terminal-block-glyph');
        part.style.width = cellWidth * run.length + 'px';
        part.style.letterSpacing = '0';
        // Keep each run together to avoid cumulative cell-width rounding.
        // CSS rectangles share pixel boundaries with the cell backgrounds.
        for (let column = 0; column < run.length; column++) for (const [x, y, width, height] of blocks.get(run.charCodeAt(column))!) {
          const rect = span.ownerDocument.createElement('i');
          rect.className = 'terminal-block-ink'; rect.setAttribute('aria-hidden', 'true');
          rect.style.left = (column * 8 + x) / (run.length * 8) * 100 + '%';
          rect.style.top = y / 8 * 100 + '%';
          rect.style.width = width / (run.length * 8) * 100 + '%';
          rect.style.height = height / 8 * 100 + '%';
          part.append(rect);
        }
      }
      return [part];
    });
  });
}

type RowFactory = {
  createRow(line: unknown, row: number, cursor: boolean, cursorStyle: unknown, inactiveStyle: unknown,
    cursorX: number, blink: boolean, cellWidth: number, ...rest: unknown[]): HTMLSpanElement[];
};
type DomCore = { _renderService?: { _renderer: { value?: { _rowFactory: RowFactory } } } };

// xterm 6.0's DOM renderer lacks custom glyphs. Its row factory also paints the
// frozen iOS selection grid, so keep its text, colors and receiver intact.
export class BlockGlyphsAddon implements ITerminalAddon {
  private restore?: () => void;
  activate(terminal: Terminal): void {
    const factory = (terminal as unknown as { _core: DomCore })._core._renderService?._renderer.value?._rowFactory;
    if (!factory) return;
    const original = factory.createRow;
    const createRow: RowFactory['createRow'] = function (this: RowFactory, ...args) {
      return paintBlocks(original.apply(this, args), args[7]);
    };
    factory.createRow = createRow;
    this.restore = () => { if (factory.createRow === createRow) factory.createRow = original; };
  }
  dispose(): void { this.restore?.(); }
}
