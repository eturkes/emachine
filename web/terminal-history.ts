import { endpoint, type Link } from './transport';

interface HistoryPrompt { id: string; body: string; timestamp: number; incomplete: boolean }
interface HistoryPage { prompts: HistoryPrompt[]; nextCursor: string | null }
interface HistoryActions {
  link(): Link;
  project(): string;
  focusTerminal(): void;
}

function historyPage(value: unknown): HistoryPage {
  const page = value as Partial<HistoryPage> | null;
  if (!page || !Array.isArray(page.prompts) || page.prompts.length > 50
    || page.nextCursor !== null && (typeof page.nextCursor !== 'string' || !page.nextCursor || page.nextCursor.length > 4096)) {
    throw new Error('The machine returned an invalid prompt history page.');
  }
  const ids = new Set<string>();
  const prompts = page.prompts.map(prompt => {
    if (!prompt || typeof prompt.id !== 'string' || !prompt.id || ids.has(prompt.id)
      || typeof prompt.body !== 'string' || !prompt.body.trim()
      || !Number.isSafeInteger(prompt.timestamp) || prompt.timestamp < 0 || prompt.timestamp > 8640000000000000
      || typeof prompt.incomplete !== 'boolean') {
      throw new Error('The machine returned an invalid prompt history entry.');
    }
    ids.add(prompt.id);
    return { id: prompt.id, body: prompt.body, timestamp: prompt.timestamp, incomplete: prompt.incomplete };
  });
  return { prompts, nextCursor: page.nextCursor };
}

let nextId = 0;

export class TerminalHistory {
  readonly element = document.createElement('aside');
  readonly button = document.createElement('button');
  private list = document.createElement('ol');
  private status = document.createElement('p');
  private reload = document.createElement('button');
  private older = document.createElement('button');
  private prompts = new Map<string, HistoryPrompt>();
  private cursors = new Set<string>();
  private nextCursor: string | null = null;
  private source = '';
  private error = '';
  private loading = false;
  private disposed = false;
  private request?: AbortController;

  constructor(private actions: HistoryActions) {
    this.element.id = 'terminal-history-' + ++nextId;
    this.element.className = 'history-sidebar'; this.element.hidden = true;
    const title = document.createElement('h2'); title.textContent = 'Prompt history';
    title.id = this.element.id + '-title'; this.element.setAttribute('aria-labelledby', title.id);
    this.button.type = 'button'; this.button.textContent = 'History';
    this.button.setAttribute('aria-controls', this.element.id);
    this.button.setAttribute('aria-expanded', 'false');
    this.button.onclick = () => { if (this.element.hidden) this.open(); else this.close(); };
    const close = document.createElement('button');
    close.type = 'button'; close.className = 'text-button'; close.textContent = 'Collapse';
    close.setAttribute('aria-label', 'Collapse prompt history'); close.onclick = () => this.close();
    const header = document.createElement('div'); header.className = 'history-header'; header.append(title, close);
    const description = document.createElement('p'); description.className = 'history-description';
    description.textContent = 'Claude Code history for this project. Newest prompts first.';
    this.list.className = 'history-list'; this.list.setAttribute('role', 'list'); this.list.setAttribute('aria-label', 'Prompts, newest first');
    this.list.tabIndex = 0;
    this.status.className = 'history-status'; this.status.setAttribute('role', 'status');
    this.reload.type = 'button'; this.reload.className = 'text-button'; this.reload.textContent = 'Reload history';
    this.reload.onclick = () => { void this.load(); };
    this.older.type = 'button'; this.older.className = 'text-button'; this.older.textContent = 'Load older';
    this.older.onclick = () => { if (!this.loading && this.nextCursor !== null) void this.load(true); };
    const controls = document.createElement('div'); controls.className = 'history-controls'; controls.append(this.reload, this.older);
    const footer = document.createElement('div'); footer.className = 'history-footer'; footer.append(this.status, controls);
    this.element.append(header, description, this.list, footer);
    this.element.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault(); event.stopPropagation(); this.close();
    });
    this.refresh();
  }

  private identity(): string {
    const link = this.actions.link();
    return JSON.stringify([link.state?.machine.id, link.route, this.actions.project()]);
  }

  private cancel(): void {
    this.request?.abort(); this.request = undefined; this.loading = false;
  }

  private clear(): void {
    this.prompts.clear(); this.cursors.clear(); this.nextCursor = null;
    this.list.replaceChildren(); this.list.scrollTop = 0;
  }

  private open(): void {
    if (this.disposed || !this.element.hidden) return;
    this.element.hidden = false; this.button.setAttribute('aria-expanded', 'true');
    this.list.focus({ preventScroll: true });
    void this.load();
  }

  close(focus = true): void {
    const wasOpen = !this.element.hidden;
    this.cancel(); this.element.hidden = true; this.button.setAttribute('aria-expanded', 'false');
    if (wasOpen && focus && !this.disposed) this.actions.focusTerminal();
  }

  update(): void {
    if (this.source !== this.identity()) {
      this.cancel(); this.clear(); this.source = this.identity(); this.error = '';
      if (!this.element.hidden) { void this.load(); return; }
    }
    this.refresh();
  }

  private refresh(): void {
    this.list.setAttribute('aria-busy', String(this.loading));
    this.reload.disabled = this.loading; this.older.disabled = this.loading;
    this.older.hidden = this.nextCursor === null;
    this.status.textContent = this.loading ? 'Loading prompt history...'
      : this.error || (this.prompts.size ? this.prompts.size + (this.prompts.size === 1 ? ' prompt loaded.' : ' prompts loaded.')
        : this.nextCursor !== null ? 'No prompts in this section. Load older to continue.'
          : 'No Claude Code prompts were found for this project.');
  }

  private entry(prompt: HistoryPrompt): HTMLLIElement {
    const item = document.createElement('li'); item.className = 'history-entry';
    const header = document.createElement('div'); header.className = 'history-entry-header';
    const time = document.createElement('time'); const date = new Date(prompt.timestamp);
    time.dateTime = date.toISOString(); time.textContent = date.toLocaleString(); time.title = time.dateTime;
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'text-button'; copy.textContent = 'Copy prompt';
    copy.onclick = () => { void this.copy(prompt); };
    header.append(time, copy);
    const body = document.createElement('pre'); body.className = 'history-body'; body.textContent = prompt.body;
    item.append(header, body);
    if (prompt.incomplete) {
      const hint = document.createElement('p'); hint.className = 'history-incomplete';
      hint.textContent = 'Some pasted text could not be loaded.'; item.append(hint);
    }
    return item;
  }

  private async copy(prompt: HistoryPrompt): Promise<void> {
    const current = () => !this.disposed && !this.element.hidden && this.source === this.identity() && this.prompts.get(prompt.id) === prompt;
    if (!current()) return;
    try {
      await navigator.clipboard.writeText(prompt.body);
      if (current()) this.status.textContent = 'Prompt copied.';
    } catch {
      if (current()) this.status.textContent = 'Clipboard access was not granted. Select and copy the prompt text.';
    }
  }

  private async load(older = false): Promise<void> {
    if (this.disposed || this.element.hidden) return;
    const cursor = older ? this.nextCursor : null;
    if (older && cursor === null) return;
    this.cancel();
    if (!older) this.clear();
    const request = new AbortController(); this.request = request;
    const link = this.actions.link(), route = link.route, project = this.actions.project();
    const source = this.identity(); this.source = source;
    this.error = ''; this.loading = true; this.refresh();
    const timer = window.setTimeout(() => request.abort(), 10000);
    try {
      if (!link.online || !route || !project) throw new Error('Reconnect to load prompt history from this machine.');
      const url = new URL(endpoint(route, 'api/v1/projects/' + encodeURIComponent(project) + '/prompt-history'));
      if (cursor !== null) url.searchParams.set('cursor', cursor);
      const response = await fetch(url, { credentials: 'include', cache: 'no-store', signal: request.signal });
      if (!response.ok) throw new Error(response.status === 404
        ? 'This machine needs an Emachine server update to load prompt history.'
        : response.status === 400 ? 'Prompt history changed. Reload history to continue.'
          : 'Could not load prompt history (HTTP ' + response.status + ').');
      const page = historyPage(await response.json());
      if (this.disposed || this.request !== request || this.identity() !== source) return;
      if (page.nextCursor !== null && (page.nextCursor === cursor || this.cursors.has(page.nextCursor))) {
        throw new Error('The machine returned an invalid prompt history cursor.');
      }
      const scrollTop = this.list.scrollTop, entries = document.createDocumentFragment();
      for (const prompt of page.prompts) {
        if (this.prompts.has(prompt.id)) continue;
        this.prompts.set(prompt.id, prompt); entries.append(this.entry(prompt));
      }
      this.list.append(entries);
      // Appending older entries must not move the request the user was reading.
      this.list.scrollTop = scrollTop;
      if (cursor !== null) this.cursors.add(cursor);
      this.nextCursor = page.nextCursor;
    } catch (error) {
      if (this.disposed || this.request !== request || this.identity() !== source) return;
      this.error = request.signal.aborted ? 'The history request timed out. Try again.'
        : error instanceof Error ? error.message : 'Could not load prompt history. Try again.';
    } finally {
      window.clearTimeout(timer);
      if (!this.disposed && this.request === request) { this.request = undefined; this.loading = false; this.refresh(); }
    }
  }

  dispose(): void {
    this.disposed = true; this.close(false); this.clear(); this.element.remove(); this.button.remove();
  }
}
