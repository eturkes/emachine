import { endpoint, type Link } from './transport';

interface Prompt { id: string; title: string; body: string; steered: boolean }
interface PromptActions {
  link(): Link;
  canPaste(): boolean;
  paste(text: string): boolean;
  focusTerminal(): void;
}

function catalog(value: unknown): Prompt[] {
  const prompts = (value as { prompts?: unknown })?.prompts;
  if (!Array.isArray(prompts)) throw new Error('The machine returned an invalid prompt list.');
  const ids = new Set<string>();
  return prompts.map(prompt => {
    if (!prompt || typeof prompt.id !== 'string' || !prompt.id || ids.has(prompt.id)
      || typeof prompt.title !== 'string' || !prompt.title || typeof prompt.body !== 'string'
      || !prompt.body.trim() || typeof prompt.steered !== 'boolean') {
      throw new Error('The machine returned an invalid prompt.');
    }
    ids.add(prompt.id);
    return { id: prompt.id, title: prompt.title, body: prompt.body, steered: prompt.steered };
  });
}

let nextId = 0;

export class TerminalPrompts {
  readonly element = document.createElement('dialog');
  readonly button = document.createElement('button');
  private select = document.createElement('select');
  private steering = document.createElement('textarea');
  private steeringField = document.createElement('div');
  private preview = document.createElement('textarea');
  private status = document.createElement('p');
  private reload = document.createElement('button');
  private copy = document.createElement('button');
  private paste = document.createElement('button');
  private prompts: Prompt[] = [];
  private drafts = new Map<string, string>();
  private selection = '';
  private source = '';
  private error = '';
  private loading = false;
  private composing = false;
  private disposed = false;
  private focusOnClose = true;
  private request?: AbortController;

  constructor(private actions: PromptActions) {
    this.element.id = `terminal-prompts-${++nextId}`;
    this.element.className = 'dialog prompt-dialog';
    const title = document.createElement('h2'); title.textContent = 'Prompts';
    title.id = `${this.element.id}-title`; this.element.setAttribute('aria-labelledby', title.id);
    this.button.type = 'button'; this.button.textContent = 'Prompts';
    this.button.setAttribute('aria-controls', this.element.id);
    this.button.setAttribute('aria-haspopup', 'dialog'); this.button.setAttribute('aria-expanded', 'false');
    this.button.onclick = () => this.open();
    const close = document.createElement('button');
    close.type = 'button'; close.className = 'text-button'; close.textContent = 'Close';
    close.setAttribute('aria-label', 'Close prompts'); close.onclick = () => this.close();
    const header = document.createElement('div'); header.className = 'dialog-header'; header.append(title, close);
    const description = document.createElement('p'); description.className = 'dialog-copy';
    description.textContent = 'Choose a prompt from this machine. Steered prompts place your request at the top.';
    const choice = document.createElement('div'); choice.className = 'prompt-choice';
    const label = document.createElement('label'); label.textContent = 'Prompt'; label.append(this.select);
    this.select.onchange = () => {
      this.selection = this.select.value; this.composing = false;
      this.steering.value = this.drafts.get(this.selection) ?? ''; this.refresh();
    };
    this.reload.type = 'button'; this.reload.className = 'text-button'; this.reload.textContent = 'Reload prompts';
    this.reload.onclick = () => { void this.load(); };
    choice.append(label, this.reload);
    const steeringLabel = document.createElement('label'); steeringLabel.textContent = 'Steering';
    this.steering.rows = 3; this.steering.spellcheck = true; this.steering.autocomplete = 'off';
    this.steering.setAttribute('autocorrect', 'on'); this.steering.setAttribute('autocapitalize', 'off');
    this.steering.placeholder = 'Describe the work, scope, or direction for this session.';
    steeringLabel.append(this.steering);
    const steeringHint = document.createElement('p'); steeringHint.className = 'prompt-hint';
    steeringHint.id = `${this.element.id}-steering-hint`;
    steeringHint.textContent = 'Your request replaces the template\'s <request> slot.';
    this.steering.setAttribute('aria-describedby', steeringHint.id);
    this.steeringField.append(steeringLabel, steeringHint);
    this.steering.addEventListener('input', () => { this.drafts.set(this.selection, this.steering.value); this.refresh(); });
    this.steering.addEventListener('compositionstart', () => { this.composing = true; this.refresh(); });
    this.steering.addEventListener('compositionend', () => { this.composing = false; this.refresh(); });
    const previewLabel = document.createElement('label'); previewLabel.textContent = 'Prompt preview';
    this.preview.rows = 8; this.preview.readOnly = true; this.preview.spellcheck = false;
    this.preview.className = 'prompt-preview'; previewLabel.append(this.preview);
    this.status.className = 'prompt-status'; this.status.setAttribute('role', 'status');
    this.copy.type = 'button'; this.copy.className = 'text-button'; this.copy.textContent = 'Copy prompt';
    this.copy.onclick = () => { void this.copyPrompt(); };
    this.paste.type = 'button'; this.paste.className = 'primary-button'; this.paste.textContent = 'Paste into terminal';
    this.paste.onclick = () => {
      if (!this.ready() || !this.actions.canPaste() || !this.actions.paste(this.compose())) { this.refresh(); return; }
      this.close();
    };
    const buttons = document.createElement('div'); buttons.className = 'prompt-actions'; buttons.append(this.copy, this.paste);
    this.element.append(header, description, choice, this.steeringField, previewLabel, this.status, buttons);
    this.element.addEventListener('close', () => {
      if (this.element.open) return;
      this.request?.abort(); this.request = undefined; this.loading = false;
      this.button.setAttribute('aria-expanded', 'false');
      if (this.focusOnClose && !this.disposed) this.actions.focusTerminal();
    });
    this.refresh();
  }

  private open(): void {
    if (this.disposed || this.element.open) return;
    this.focusOnClose = true; this.element.showModal(); this.button.setAttribute('aria-expanded', 'true');
    void this.load();
  }

  close(focus = true): void {
    this.focusOnClose = focus;
    this.request?.abort(); this.request = undefined; this.loading = false;
    if (this.element.open) this.element.close();
  }

  private selected(): Prompt | undefined { return this.prompts.find(prompt => prompt.id === this.select.value); }

  private compose(): string {
    const prompt = this.selected();
    if (!prompt) return '';
    const prefix = prompt.steered && this.steering.value.trim() ? this.steering.value + '\n\n' : '';
    // Source files end with a newline; pasting it can submit an unbracketed terminal input.
    return (prefix + prompt.body).replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  }

  private ready(): boolean {
    const prompt = this.selected();
    return !this.disposed && this.element.open && !this.loading && !this.error && !this.composing && !!prompt
      && this.source === (this.actions.link().route ?? '')
      && (!prompt.steered || !!this.steering.value.trim()) && !!this.compose();
  }

  refresh(): void {
    const prompt = this.selected();
    const text = this.compose();
    if (this.preview.value !== text) this.preview.value = text;
    this.steeringField.hidden = !prompt?.steered;
    this.select.disabled = this.loading || !this.prompts.length;
    this.reload.disabled = this.loading;
    this.copy.disabled = !this.ready();
    this.paste.disabled = !this.ready() || !this.actions.canPaste();
    this.status.textContent = this.loading ? 'Loading prompts...'
      : this.error || (!prompt ? 'No prompts were found on this machine.'
        : prompt.steered && !this.steering.value.trim() ? 'Add steering to use this prompt.'
          : !this.actions.canPaste() ? 'Reconnect and take control before pasting.'
            : 'Paste adds no final Enter.');
  }

  update(): void {
    if (this.element.open && this.source !== (this.actions.link().route ?? '')) void this.load();
    else this.refresh();
  }

  private async load(): Promise<void> {
    this.request?.abort();
    const request = new AbortController(); this.request = request;
    const link = this.actions.link(), route = link.route;
    this.source = route ?? ''; this.error = ''; this.loading = true; this.refresh();
    const timer = window.setTimeout(() => request.abort(), 10000);
    try {
      if (!link.online || !route) throw new Error('Reconnect to load prompts from this machine.');
      const response = await fetch(endpoint(route, 'api/v1/prompts'), { credentials: 'include', cache: 'no-store', signal: request.signal });
      if (!response.ok) throw new Error(response.status === 404
        ? 'This machine needs an Emachine server update to load prompts.'
        : `Could not load prompts (HTTP ${response.status}).`);
      const prompts = catalog(await response.json());
      if (this.disposed || this.request !== request || this.actions.link().route !== route) return;
      this.prompts = prompts;
      this.select.replaceChildren(...prompts.map(prompt => {
        const option = document.createElement('option'); option.value = prompt.id; option.textContent = prompt.title; return option;
      }));
      this.select.value = prompts.some(prompt => prompt.id === this.selection) ? this.selection : prompts[0]?.id ?? '';
      this.selection = this.select.value;
      this.steering.value = this.drafts.get(this.selection) ?? ''; this.composing = false;
    } catch (error) {
      if (this.disposed || this.request !== request) return;
      this.prompts = []; this.select.replaceChildren();
      this.error = request.signal.aborted ? 'The prompt request timed out. Reload prompts to try again.'
        : error instanceof Error ? error.message : 'Could not load prompts. Reload prompts to try again.';
    } finally {
      window.clearTimeout(timer);
      if (!this.disposed && this.request === request) { this.request = undefined; this.loading = false; this.refresh(); }
    }
  }

  private async copyPrompt(): Promise<void> {
    if (!this.ready()) return;
    const text = this.compose();
    try {
      await navigator.clipboard.writeText(text);
      if (!this.disposed && this.element.open && this.compose() === text) this.status.textContent = 'Prompt copied.';
    } catch {
      if (!this.disposed && this.element.open) this.status.textContent = 'Clipboard access was not granted. Select and copy the preview.';
    }
  }

  dispose(): void {
    this.disposed = true; this.request?.abort(); this.request = undefined;
    this.close(false); this.drafts.clear(); this.prompts = [];
    this.steering.value = this.preview.value = ''; this.element.remove(); this.button.remove();
  }
}
