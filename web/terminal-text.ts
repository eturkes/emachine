interface TextActions {
  canSend(): boolean;
  send(text: string): boolean;
  focusTerminal(): void;
}

let nextId = 0;

export class TerminalTextInput {
  readonly element = document.createElement('section');
  readonly button = document.createElement('button');
  private text = document.createElement('textarea');
  private send = document.createElement('button');
  private hint = document.createElement('p');
  private composing = false;

  constructor(private actions: TextActions) {
    this.element.className = 'terminal-text'; this.element.hidden = true;
    this.element.id = `terminal-text-${++nextId}`;
    this.button.type = 'button'; this.button.textContent = 'Text';
    this.button.setAttribute('aria-controls', this.element.id);
    this.button.setAttribute('aria-expanded', 'false');
    this.button.onclick = () => {
      this.element.hidden = !this.element.hidden;
      this.button.setAttribute('aria-expanded', String(!this.element.hidden));
      if (this.element.hidden) this.actions.focusTerminal();
      else this.text.focus();
    };
    const label = document.createElement('label'); label.textContent = 'Terminal text';
    this.text.rows = 2; this.text.spellcheck = true; this.text.autocomplete = 'off';
    this.text.setAttribute('autocorrect', 'on');
    this.text.setAttribute('autocapitalize', 'off');
    this.hint.id = `${this.element.id}-hint`;
    this.text.setAttribute('aria-describedby', this.hint.id);
    label.append(this.text);
    this.text.addEventListener('input', () => this.refresh());
    this.text.addEventListener('compositionstart', () => { this.composing = true; this.refresh(); });
    this.text.addEventListener('compositionend', () => { this.composing = false; this.refresh(); });
    this.send.type = 'button'; this.send.className = 'text-button'; this.send.textContent = 'Send text';
    this.send.onclick = () => {
      // A native draft is not a mirror of the remote command. Only explicit Send can transfer it.
      if (this.composing || !this.text.value || !this.actions.canSend() || !this.actions.send(this.text.value)) {
        this.refresh(); return;
      }
      this.text.value = ''; this.refresh(); this.text.focus();
    };
    const footer = document.createElement('div'); footer.className = 'terminal-text-footer';
    footer.append(this.hint, this.send); this.element.append(label, footer);
    this.refresh();
  }

  refresh(): void {
    const available = this.actions.canSend();
    this.send.disabled = !available || this.composing || !this.text.value;
    this.hint.textContent = available
      ? 'Uses your keyboard\'s spelling tools. Send pastes the text.'
      : 'Reconnect and take control to send text.';
  }

  dispose(): void {
    this.text.value = ''; this.element.remove(); this.button.remove();
  }
}
