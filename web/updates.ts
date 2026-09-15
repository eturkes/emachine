type UpdateStatus = 'idle' | 'unsupported' | 'checking' | 'current' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error';
export type UpdateState = { status: UpdateStatus; version: string; message: string; nextVersion?: string; percent?: number };
type UpdateApi = {
  getState(): Promise<UpdateState>;
  check(): Promise<UpdateState>;
  download(): Promise<UpdateState>;
  install(): Promise<UpdateState>;
  onState(callback: (state: UpdateState) => void): () => void;
};
declare global { interface Window { emachineUpdates?: UpdateApi } }

export function attachAppUpdates(actions: HTMLElement, dialog: (title: string) => HTMLDialogElement): void {
  const api = window.emachineUpdates;
  if (!api) return;
  const entry = document.createElement('button');
  entry.type = 'button'; entry.className = 'text-button'; entry.textContent = 'Updates';
  entry.setAttribute('aria-label', 'App updates'); entry.title = 'App updates';
  actions.append(entry);
  entry.onclick = () => {
    const d = dialog('App updates');
    const version = document.createElement('p'); version.className = 'update-version';
    const copy = document.createElement('p'); copy.className = 'dialog-copy';
    copy.textContent = 'Get desktop client updates from GitHub Releases. This does not update your machine servers or project views.';
    const message = document.createElement('p'); message.className = 'update-message';
    message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
    const progress = document.createElement('progress'); progress.className = 'update-progress';
    progress.max = 100; progress.hidden = true; progress.setAttribute('aria-label', 'Update download progress');
    const action = document.createElement('button'); action.type = 'button'; action.className = 'primary-button';
    action.textContent = 'Check for updates'; action.disabled = true;
    const footnote = document.createElement('p'); footnote.className = 'origin-note';
    footnote.textContent = 'Nothing downloads or installs automatically. Restarting the client leaves server terminals and jobs running.';
    d.append(version, copy, message, progress, action, footnote);
    let state: UpdateState;
    let pending = false;
    let closed = false;
    const render = (next: UpdateState) => {
      if (closed) return;
      state = next;
      version.textContent = `Installed version: ${state.version}`;
      message.textContent = state.message;
      message.classList.toggle('danger-text', state.status === 'error');
      progress.hidden = state.status !== 'downloading'; progress.value = state.percent ?? 0;
      action.textContent = state.status === 'available' ? 'Download update' : state.status === 'downloaded' ? 'Restart and install' :
        state.status === 'checking' ? 'Checking...' : state.status === 'downloading' ? 'Downloading...' :
        state.status === 'installing' ? 'Restarting...' : 'Check for updates';
      action.disabled = pending || ['unsupported', 'checking', 'downloading', 'installing'].includes(state.status);
    };
    const failed = () => render({ status: 'error', version: state?.version ?? 'unknown', message: 'The update controls are unavailable. Close this dialog and try again.' });
    const unsubscribe = api.onState(render);
    d.addEventListener('close', () => { closed = true; unsubscribe(); }, { once: true });
    action.onclick = async () => {
      if (!state || pending || action.disabled) return;
      const method = state.status === 'available' ? 'download' : state.status === 'downloaded' ? 'install' : 'check';
      pending = true; render(state);
      try { state = await api[method](); }
      catch { failed(); }
      finally { pending = false; render(state); }
    };
    d.showModal();
    void api.getState().then(render).catch(failed);
  };
}
