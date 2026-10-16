import type { Terminal } from '@xterm/xterm';

const backwardEdit = /^delete(?:Content|Word|SoftLine|HardLine)Backward$/;

export function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

export function attachTerminalInput(host: HTMLElement, terminal: Terminal): () => void {
  const textarea = terminal.textarea;
  if (!isIOS() || !textarea) return () => {};
  const lifetime = new AbortController(), { signal } = lifetime;
  let composing = false, settling = false, timer: number | undefined;
  const ready = () => !signal.aborted && !composing && !settling && document.activeElement === textarea;
  const seed = () => {
    // iOS stops native deletion at an empty textarea; the helper is not the remote command.
    if (!ready() || textarea.value) return;
    textarea.value = '\u200b';
    textarea.setSelectionRange(1, 1);
  };
  const settle = () => {
    composing = false; settling = true;
    window.clearTimeout(timer);
    // xterm reads the final composition in a zero-delay task. Seed only after that read.
    timer = window.setTimeout(() => { settling = false; seed(); }, 0);
  };
  textarea.addEventListener('focus', seed, { signal });
  textarea.addEventListener('blur', settle, { signal });
  textarea.addEventListener('compositionstart', () => { composing = true; }, { signal });
  textarea.addEventListener('compositionend', settle, { signal });
  host.addEventListener('keydown', event => {
    if (event.target !== textarea || !ready() || event.isComposing || event.defaultPrevented ||
      event.key !== 'Backspace' || event.ctrlKey || event.altKey || event.metaKey) return;
    seed();
    // Run before xterm's textarea capture listener. Canceling keydown stops iOS hold-to-delete.
    event.stopPropagation();
  }, { capture: true, signal });
  host.addEventListener('beforeinput', event => {
    const input = event as InputEvent;
    if (event.target === textarea && !input.isComposing && backwardEdit.test(input.inputType)) seed();
  }, { capture: true, signal });
  host.addEventListener('input', event => {
    const input = event as InputEvent;
    if (event.target !== textarea || !ready() || input.isComposing || !backwardEdit.test(input.inputType)) return;
    event.stopPropagation();
    // One native backward edit = one terminal Backspace, including accelerated word/line edits.
    terminal.input('\u007f', true);
    seed();
  }, { capture: true, signal });
  // Enter and paste can clear xterm's helper after onData returns.
  const data = terminal.onData(() => queueMicrotask(seed));
  seed();
  return () => {
    lifetime.abort(); data.dispose(); window.clearTimeout(timer);
    if (textarea.value === '\u200b') textarea.value = '';
  };
}
