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
        const batch: Array<{ data: Uint8Array; parsed: Array<() => void> }> = [];
        let bytes = 0;
        while (this.queue.length && bytes < maxPendingBytes) {
          if (typeof this.queue[0] === 'function') break;
          const parts: Uint8Array[] = [], parsed: Array<() => void> = [];
          const limit = Math.min(parseChunkBytes, maxPendingBytes - bytes);
          let length = 0;
          while (this.queue.length && length < limit) {
            const update = this.queue[0];
            if (typeof update === 'function') break;
            const end = Math.min(update.data.length, update.offset + limit - length);
            parts.push(update.data.subarray(update.offset, end));
            length += end - update.offset; update.offset = end;
            if (end === update.data.length) {
              this.queue.shift();
              if (update.parsed) parsed.push(update.parsed);
            }
          }
          let data = parts[0];
          if (parts.length > 1) {
            data = new Uint8Array(length);
            let offset = 0;
            for (const part of parts) { data.set(part, offset); offset += part.length; }
          }
          bytes += length; batch.push({ data, parsed });
        }
        // Keep xterm's own time-sliced parser supplied without adding a timer per packet.
        // Raw slices retain split UTF-8/parser state; actions never cross this bounded burst.
        batch.forEach((part, index) => this.terminal.write(part.data, () => {
          // A combined chunk can complete several frames; checkpoint them only after parsing it.
          if (!this.disposed) for (const parsed of part.parsed) parsed();
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
