import type { Terminal } from '@xterm/xterm';

type Update = (() => void) | { parts: Uint8Array[]; bytes: number };
const maxBatchBytes = 64 * 1024;

// xterm parses writes asynchronously; geometry and resets must wait for those bytes.
export class TerminalOutput {
  private queue: Update[] = [];
  private busy = false;
  private disposed = false;
  constructor(private terminal: Pick<Terminal, 'write'>) {}

  write(data: Uint8Array): void {
    if (this.disposed || !data.length) return;
    const previous = this.queue.at(-1);
    if (previous && typeof previous !== 'function' && previous.bytes + data.length <= maxBatchBytes) {
      previous.parts.push(data); previous.bytes += data.length;
    } else this.queue.push({ parts: [data], bytes: data.length });
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
      while (this.queue.length) {
        const update = this.queue.shift()!;
        if (typeof update === 'function') { update(); continue; }
        // Bounded batches preserve parser yields without decoding split UTF-8 or crossing actions.
        let data = update.parts[0];
        if (update.parts.length > 1) {
          data = new Uint8Array(update.bytes);
          let offset = 0;
          for (const part of update.parts) { data.set(part, offset); offset += part.length; }
        }
        this.terminal.write(data, () => {
          // Leave xterm's parser stack before resizing, resetting, or submitting more bytes.
          queueMicrotask(() => { this.busy = false; this.drain(); });
        });
        return;
      }
    } catch (error) { this.busy = false; throw error; }
    this.busy = false;
  }

  dispose(): void { this.disposed = true; this.queue.length = 0; }
}
