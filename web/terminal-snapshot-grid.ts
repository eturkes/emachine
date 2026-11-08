import type { IBufferLine, ITerminalOptions, Terminal } from '@xterm/xterm';

// xterm 6.0.0 exposes buffer text publicly, but only its DOM renderer resolves
// contrast, decorations, inverse colors and glyph spacing exactly as displayed.
type Options = Required<Pick<ITerminalOptions, 'fontFamily' | 'fontSize' | 'fontWeight' | 'fontWeightBold' | 'minimumContrastRatio' | 'drawBoldTextInBrightColors'>>;
type WidthCache = {
  _flat: Float32Array;
  setFont(font: string, size: number, regular: Options['fontWeight'], bold: Options['fontWeightBold']): void;
  dispose(): void;
};
type Colors = { ansi: unknown[]; contrastCache: object; halfContrastCache: object };
type RawLine = { clone(): RawLine };
type RowFactory = {
  _workCell: unknown;
  _optionsService: { rawOptions: Options };
  _themeService: { colors: Colors };
  _characterJoinerService: { getJoinedCharacters(row: number): [number, number][] };
  _decorationService: { forEachDecorationAtCell(): void };
  handleSelectionChanged(start: undefined, end: undefined, column: boolean): void;
  createRow(line: RawLine, row: number, cursor: boolean, cursorStyle: undefined, inactiveStyle: undefined,
    cursorX: number, blink: boolean, cellWidth: number, widthCache: WidthCache, linkStart: number, linkEnd: number): HTMLSpanElement[];
};

type DomRenderer = {
  _rowFactory: RowFactory;
  _widthCache: WidthCache;
  _helperContainer: HTMLElement;
  _rowContainer: HTMLElement;
  _themeStyleElement: HTMLStyleElement;
  _dimensionsStyleElement: HTMLStyleElement;
  dimensions: { css: { cell: { width: number; height: number }; canvas: { width: number } } };
};

type BrowserCore = {
  buffer: { lines: { get(row: number): RawLine } };
  _renderService?: { _renderer: { value?: DomRenderer } };
};

export function snapshotGrid(terminal: Terminal, host: HTMLElement) {
  const core = (terminal as unknown as { _core: BrowserCore })._core;
  const renderer = core._renderService?._renderer.value;
  const owner = Array.from(terminal.element?.classList ?? []).find(name => name.startsWith('xterm-dom-renderer-owner-'));
  const viewport = host.querySelector<HTMLElement>('.xterm-scrollable-element');
  const buffer = terminal.buffer.active, first = buffer.getLine(0);
  if (!owner || !viewport || !renderer?._rowFactory || !first) return;
  const rows = renderer._rowContainer;
  const cellWidth = renderer.dimensions.css.cell.width;
  const rowHeight = rows.firstElementChild?.getBoundingClientRect().height || renderer.dimensions.css.cell.height;
  if (rowHeight <= 0 || cellWidth <= 0) return;

  // Scrollback can trim and OSC commands can recolor the live terminal before
  // the user scrolls to a frozen row. Capture the factory's paint inputs once.
  const lines = Array.from({ length: buffer.length }, (_, row) => core.buffer.lines.get(row).clone());
  const LineView = first.constructor as new (line: RawLine) => IBufferLine;
  const factory: RowFactory = Object.create(renderer._rowFactory);
  factory._workCell = buffer.getNullCell();
  factory.handleSelectionChanged(undefined, undefined, false);
  const options = { ...factory._optionsService.rawOptions };
  factory._optionsService = { rawOptions: options };
  const colors = factory._themeService.colors;
  const ContrastCache = colors.contrastCache.constructor as new () => object;
  factory._themeService = { colors: { ...colors, ansi: colors.ansi.slice(), contrastCache: new ContrastCache(), halfContrastCache: new ContrastCache() } };
  // This terminal installs neither character joiners nor decorations.
  factory._characterJoinerService = { getJoinedCharacters: () => [] };
  factory._decorationService = { forEachDecorationAtCell() {} };
  const Measure = renderer._widthCache.constructor as new (doc: Document, helper: HTMLElement) => WidthCache;
  const widths = new Measure(document, renderer._helperContainer);
  widths.setFont(options.fontFamily, options.fontSize, options.fontWeight, options.fontWeightBold);
  widths._flat.set(renderer._widthCache._flat);
  const ownerClass = owner + '-snapshot', rowsClass = 'terminal-frozen-rows';
  const css = document.createElement('style');
  css.textContent = [renderer._themeStyleElement, renderer._dimensionsStyleElement]
    .map(style => style.textContent ?? '').join('\n')
    .replaceAll('.' + owner, '.' + ownerClass).replaceAll('.xterm-rows', '.' + rowsClass)
    .replaceAll('blink_', 'snapshot_blink_')
    + `\n.${ownerClass} .${rowsClass} { pointer-events: auto; }`;
  const origin = rows.getBoundingClientRect(), bounds = host.getBoundingClientRect();
  return {
    css, ownerClass, rowsClass, rowHeight, width: renderer.dimensions.css.canvas.width,
    scrollOffsetY: bounds.top - origin.top, scrollLeft: bounds.left - origin.left,
    background: getComputedStyle(viewport).backgroundColor, letterSpacing: getComputedStyle(rows).letterSpacing,
    length: lines.length,
    line(row: number) { return new LineView(lines[row]); },
    paint(row: number) { return factory.createRow(lines[row], row, false, undefined, undefined, 0, false, cellWidth, widths, -1, -1); },
    dispose() { widths.dispose(); },
  };
}
