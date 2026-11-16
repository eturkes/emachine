import type { IBufferCell, ITerminalAddon, Terminal } from '@xterm/xterm';

type Color = { css: string; rgba: number };
type RowFactory = {
  _optionsService: { rawOptions: { minimumContrastRatio: number } };
  _themeService: { colors: { background: Color } };
  _applyMinimumContrast(element: HTMLElement, background: Color, foreground: Color, cell: IBufferCell,
    backgroundOverride: Color | undefined, foregroundOverride: Color | undefined): boolean;
};
type DomCore = { _renderService?: { _renderer: { value?: { _rowFactory: RowFactory } } } };

// Programs can retain a dark message fill after the terminal switches to light.
// xterm 6.0 only offers global contrast correction; keep explicit text colors
// intact and correct the theme's default text against program-owned backgrounds.
export class DefaultTextContrastAddon implements ITerminalAddon {
  private restore?: () => void;
  activate(terminal: Terminal): void {
    const factory = (terminal as unknown as { _core: DomCore })._core._renderService?._renderer.value?._rowFactory;
    if (!factory) return;
    const original = factory._applyMinimumContrast;
    const applyMinimumContrast: RowFactory['_applyMinimumContrast'] = function (this: RowFactory, element, background, foreground, cell, backgroundOverride, foregroundOverride) {
      const inverse = !!cell.isInverse();
      const defaultForeground = inverse ? cell.isBgDefault() : cell.isFgDefault();
      if (!defaultForeground || foregroundOverride) return original.call(this, element, background, foreground, cell, backgroundOverride, foregroundOverride);

      // The stock default-color branch passes the normal foreground even when
      // inverse text actually uses the theme background.
      const resolvedForeground = inverse ? this._themeService.colors.background : foreground;
      const defaultBackground = inverse ? cell.isFgDefault() : cell.isBgDefault();
      if (this._optionsService.rawOptions.minimumContrastRatio !== 1 || (defaultBackground && !backgroundOverride)) {
        return original.call(this, element, background, resolvedForeground, cell, backgroundOverride, foregroundOverride);
      }

      // Preserve the receiver so frozen selection uses its captured theme and
      // caches. Reuse xterm's dim, glyph and selection handling without changing
      // terminal options or any buffer/PTY bytes.
      const contrast = Object.create(this) as RowFactory;
      contrast._optionsService = { rawOptions: { ...this._optionsService.rawOptions, minimumContrastRatio: 4.5 } };
      return original.call(contrast, element, background, resolvedForeground, cell, backgroundOverride, foregroundOverride);
    };
    factory._applyMinimumContrast = applyMinimumContrast;
    this.restore = () => { if (factory._applyMinimumContrast === applyMinimumContrast) factory._applyMinimumContrast = original; };
  }
  dispose(): void { this.restore?.(); }
}
