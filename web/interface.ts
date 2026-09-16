type InterfaceState = {
  status: 'unconfigured' | 'idle' | 'checking' | 'available' | 'current' | 'loading' | 'error';
  source: string; revision: string; message: string; bundled: boolean;
  availableRevision?: string; downloadedBytes?: number;
};
type InterfaceApi = {
  getState(): Promise<InterfaceState>;
  setSource(source: string): Promise<InterfaceState>;
  check(): Promise<InterfaceState>;
  refresh(): Promise<InterfaceState>;
  restore(): Promise<InterfaceState>;
  ready(): Promise<InterfaceState>;
  onState(callback: (state: InterfaceState) => void): () => void;
};
declare global { interface Window { emachineInterface?: InterfaceApi } }

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = '') => {
  const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
};
const button = (text: string, className = 'text-button') => {
  const node = element('button', className, text); node.type = 'button'; return node;
};
export function attachInterfaceUpdates(actions: HTMLElement, dialog: (title: string) => HTMLDialogElement, suggestedSource: () => string): void {
  const api = window.emachineInterface;
  if (!api) return;
  const entry = button('Refresh', 'text-button interface-control');
  entry.setAttribute('aria-label', 'Interface updates'); entry.title = 'Interface updates';
  const announcement = element('span', 'interface-announcement');
  announcement.setAttribute('role', 'status');
  actions.append(entry, announcement);
  const badge = (state: InterfaceState) => {
    const available = state.status === 'available';
    entry.classList.toggle('has-update', available);
    entry.title = available ? 'New interface available - refresh when ready' : 'Interface updates';
    const text = available ? 'A new interface is available. Open Refresh to apply it.' : '';
    if (announcement.textContent !== text) announcement.textContent = text;
  };
  api.onState(badge);
  void api.getState().then(badge).catch(() => {});
  entry.onclick = () => {
    const d = dialog('Interface updates');
    const copy = element('p', 'dialog-copy', 'Refresh the interface without replacing the AppImage. Install desktop runtime and security updates separately from GitHub Releases.');
    const version = element('p', 'interface-version');
    const form = element('form', 'interface-source-form');
    const label = element('label', '', 'Interface source');
    const source = element('input', ''); source.type = 'url'; source.autocomplete = 'off'; source.spellcheck = false;
    source.placeholder = 'https://your-machine.tailnet.ts.net:4743/'; label.append(source);
    const trust = button('Use this source'); trust.type = 'submit';
    form.append(label, trust);
    const trustNote = element('p', 'origin-note', 'This server supplies application code. Use a server you control. Changing projects does not change the source.');
    const message = element('p', 'interface-message'); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
    const controls = element('div', 'interface-actions');
    const refresh = button('Refresh interface', 'primary-button');
    const check = button('Check interface');
    const restore = button('Use bundled interface');
    controls.append(refresh, check, restore);
    const footnote = element('p', 'origin-note', 'The app checks for changes each minute. Only Refresh downloads changed files and reloads the interface.');
    const warning = element('p', 'dialog-copy', 'Save work in open views before reloading. Server terminals and jobs keep running. Your saved connections and project selection remain.');
    d.append(copy, version, form, trustNote, message, controls, footnote, warning);
    let state: InterfaceState;
    let pending = false; let closed = false; let initialized = false;
    const render = (next: InterfaceState) => {
      if (closed) return;
      state = next;
      if (!initialized) { source.value = state.source || suggestedSource(); initialized = true; }
      version.textContent = `Interface revision: ${state.revision.slice(0, 12)}${state.bundled ? ' (bundled)' : ' (cached)'}`;
      message.textContent = state.message;
      message.classList.toggle('danger-text', state.status === 'error');
      const busy = pending || ['checking', 'loading'].includes(state.status);
      trust.disabled = busy; source.disabled = busy;
      refresh.disabled = busy || !state.source; check.disabled = busy || !state.source;
      restore.disabled = busy || state.bundled;
      refresh.textContent = state.status === 'loading' ? 'Refreshing...' : 'Refresh interface';
    };
    const execute = async (operation: () => Promise<InterfaceState>) => {
      if (!state || pending) return;
      pending = true; render(state);
      try { state = await operation(); }
      catch { state = { ...state, status: 'error', message: 'The interface controls are unavailable. Reopen this dialog or use the native Interface menu.' }; }
      finally { pending = false; render(state); }
    };
    form.onsubmit = event => { event.preventDefault(); void execute(() => api.setSource(source.value)); };
    refresh.onclick = () => { void execute(() => api.refresh()); };
    check.onclick = () => { void execute(() => api.check()); };
    restore.onclick = () => { void execute(() => api.restore()); };
    const unsubscribe = api.onState(render);
    d.addEventListener('close', () => { closed = true; unsubscribe(); }, { once: true });
    d.showModal();
    void api.getState().then(render).catch(() => { message.textContent = 'Interface controls are unavailable. Use the native Interface menu to recover.'; });
  };
}
