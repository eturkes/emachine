import type { IDisposable, Terminal } from '@xterm/xterm';

// Public parser hooks run immediately before xterm's synchronous query replies.
// Mark that call stack only: a typed or pasted escape sequence is never a reply.
export class TerminalReplies {
  private reply = false;
  private version = 0;
  private handlers: IDisposable[];
  constructor(terminal: Terminal) {
    const mark = () => {
      this.reply = true;
      const version = ++this.version;
      queueMicrotask(() => { if (version === this.version) this.reply = false; });
      return false;
    };
    this.handlers = [
      ...[
        { final: 'c' }, { prefix: '>', final: 'c' },
        { final: 'n' }, { prefix: '?', final: 'n' },
        { intermediates: '$', final: 'p' }, { prefix: '?', intermediates: '$', final: 'p' },
        { final: 't' },
      ].map(id => terminal.parser.registerCsiHandler(id, mark)),
      ...[4, 10, 11, 12].map(id => terminal.parser.registerOscHandler(id, mark)),
      terminal.parser.registerDcsHandler({ intermediates: '$', final: 'q' }, mark),
    ];
  }
  get generated(): boolean { return this.reply; }
  dispose(): void { this.version++; this.reply = false; for (const handler of this.handlers) handler.dispose(); }
}
