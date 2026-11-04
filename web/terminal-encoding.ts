export type TerminalEncoding = 'gzip-v1';
const maxDecodedBytes = 65536;

export function supportedTerminalEncoding(): TerminalEncoding | undefined {
  if (typeof DecompressionStream !== 'function') return;
  try { new DecompressionStream('gzip'); return 'gzip-v1'; } catch { return; }
}

// Raw frames stay synchronous; only independently compressed frames suspend delivery.
export function decodeTerminalFrame(frame: Uint8Array, encoding: TerminalEncoding | undefined, signal: AbortSignal): Uint8Array | Promise<Uint8Array> {
  if (!encoding) return frame.subarray(8);
  if (frame.length < 14 || frame.length > maxDecodedBytes + 13) throw new Error('Invalid terminal frame size');
  const length = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(9);
  if (length < 1 || length > maxDecodedBytes) throw new Error('Invalid terminal decoded size');
  const body = frame.subarray(13);
  if (frame[8] === 0) {
    if (body.length !== length) throw new Error('Invalid raw terminal frame');
    return body;
  }
  if (frame[8] !== 1) throw new Error('Unknown terminal codec');
  return inflate(body, length, signal);
}

async function inflate(body: Uint8Array, length: number, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted();
  let offset = 0;
  // Bound both the input fed to the inflater and the output retained for one frame.
  const source = new ReadableStream<BufferSource>({
    pull(controller) {
      if (offset === body.length) { controller.close(); return; }
      const end = Math.min(offset + 1024, body.length);
      controller.enqueue(body.slice(offset, end)); offset = end;
    },
  });
  const reader = source.pipeThrough(new DecompressionStream('gzip'), { signal }).getReader();
  const bytes = new Uint8Array(length);
  let written = 0;
  try {
    for (;;) {
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      if (written + next.value.length > length) throw new Error('Terminal decoded size exceeded');
      bytes.set(next.value, written); written += next.value.length;
    }
    if (written !== length) throw new Error('Incomplete terminal frame');
    return bytes;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
