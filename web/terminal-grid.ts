import type { IBuffer, Terminal } from '@xterm/xterm';

// xterm 6.0's public buffer is read-only. Keep the two alternate-screen
// workarounds (xtermjs/xterm.js#6163 and #6228) confined to this adapter.
type AlternateBufferView = IBuffer & {
  _buffer: {
    getNullCell(): unknown;
    lines: {
      length: number;
      maxLength: number;
      get(row: number): {
        length: number;
        getWidth(column: number): number;
        resize(columns: number, fill: unknown): void;
      };
    };
  };
};

export function syncAlternateScreen(terminal: Terminal): void {
  const { _buffer } = terminal.buffer.alternate as AlternateBufferView;
  const { lines } = _buffer;
  if (!lines.length) {
    // A later alternate-screen scroll must discard rows at the current height.
    lines.maxLength = terminal.rows;
    return;
  }
  const cols = terminal.cols;
  const blank = _buffer.getNullCell();
  for (let row = 0; row < lines.length; row++) {
    const line = lines.get(row);
    if (line.length <= cols) continue;
    // Discard the entire wide glyph when the new right edge cuts it in half.
    if (line.getWidth(cols - 1) === 2) line.resize(cols - 1, blank);
    line.resize(cols, blank);
  }
}
