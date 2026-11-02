import type { IDisposable, Terminal } from '@xterm/xterm';

const begin = 'EmachineRestore=begin', end = 'EmachineRestore=end';
const restoreTimeout = 10000;

// The private zmx client marks its initial snapshot. Keep its native buffer parsing
// after xterm's synchronized-output watchdog expires without displaying partial history.
export class TerminalRestore {
  private handler: IDisposable;
  private armed = false;
  private disposed = false;
  private generation = 0;
  private timer?: number;
  private held?: { element: HTMLElement; opacity: string; priority: string };
  constructor(private terminal: Pick<Terminal, 'parser' | 'element' | 'refresh' | 'rows'>, private changed: () => void) {
    this.handler = terminal.parser.registerOscHandler(1337, data => {
      if (data !== begin && data !== end) return false;
      if (this.disposed) return true;
      if (data === begin) {
        if (!this.armed) return true;
        this.armed = false;
        const element = this.terminal.element;
        if (!element) return true;
        this.held = { element, opacity: element.style.getPropertyValue('opacity'), priority: element.style.getPropertyPriority('opacity') };
        element.style.opacity = '0';
        const generation = ++this.generation;
        this.timer = window.setTimeout(() => { if (generation === this.generation) this.finish(); }, restoreTimeout);
        this.changed();
      } else if (this.held) {
        const generation = this.generation;
        // Leave the parser stack before exposing the completed screen.
        queueMicrotask(() => { if (generation === this.generation) this.finish(); });
      }
      return true;
    });
  }

  get active(): boolean { return this.held !== undefined; }

  reset(): void {
    if (this.disposed) return;
    this.finish(false); this.armed = true;
  }

  private finish(refresh = true): void {
    this.generation++;
    window.clearTimeout(this.timer); this.timer = undefined;
    const held = this.held; this.held = undefined;
    if (!held) return;
    if (held.opacity) held.element.style.setProperty('opacity', held.opacity, held.priority);
    else held.element.style.removeProperty('opacity');
    if (refresh && !this.disposed && held.element.isConnected && this.terminal.element === held.element) {
      this.terminal.refresh(0, this.terminal.rows - 1);
    }
    this.changed();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.armed = false;
    this.finish(false); this.handler.dispose();
  }
}
