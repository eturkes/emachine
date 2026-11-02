import type { Terminal } from '@xterm/xterm';

type Update = (() => void) | { data: Uint8Array; offset: number; parsed?: () => void };
const parseChunkBytes = 16 * 1024;
const maxPendingBytes = 256 * 1024;

// xterm parses writes asynchronously; geometry and resets must wait for those bytes.
export class TerminalOutput {
  private queue: Update[] = [];
  private busy = false;
  private disposed = false;
  constructor(private terminal: Pick<Terminal, 'write'>) {}

  // parsed only commits a checkpoint; terminal mutations must use run outside the parser.
  write(data: Uint8Array, parsed?: () => void): void {
    if (this.disposed) return;
    if (!data.length) { if (parsed) this.run(parsed); return; }
    this.queue.push({ data, offset: 0, parsed });
    this.drain();
  }

  run(action: () => void): void {
    if (this.disposed) return;
    this.queue.push(action);
    this.drain();
  }

  reset(action: () => void): void {
    // Drop the obsolete attachment's queued work, but let its active write finish first.
    this.queue.length = 0;
    this.run(action);
  }

  private drain(): void {
    if (this.busy || this.disposed) return;
    this.busy = true;
    try {
      while (typeof this.queue[0] === 'function') (this.queue.shift() as () => void)();
      if (this.queue.length) {
        const batch: Array<{ data: Uint8Array; parsed?: () => void }> = [];
        let bytes = 0;
        while (this.queue.length && bytes < maxPendingBytes) {
          const update = this.queue[0];
          if (typeof update === 'function') break;
          const end = Math.min(update.data.length, update.offset + parseChunkBytes, update.offset + maxPendingBytes - bytes);
          const data = update.data.subarray(update.offset, end);
          update.offset = end; bytes += data.length;
          const complete = end === update.data.length;
          batch.push({ data, parsed: complete ? update.parsed : undefined });
          if (complete) this.queue.shift();
        }
        // Keep xterm's own time-sliced parser supplied without adding a timer per packet.
        // Raw slices retain split UTF-8/parser state; actions never cross this bounded burst.
        batch.forEach((part, index) => this.terminal.write(part.data, () => {
          if (!this.disposed) part.parsed?.();
          if (index === batch.length - 1) {
            // Leave the parser stack before resizing, resetting, or submitting another burst.
            queueMicrotask(() => { this.busy = false; this.drain(); });
          }
        }));
        return;
      }
    } catch (error) { this.busy = false; throw error; }
    this.busy = false;
  }

  dispose(): void { this.disposed = true; this.queue.length = 0; }
}
