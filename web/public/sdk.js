// Optional browser SDK. The parent supplies machine/project context; no credentials are embedded.
let current;
let resolveContext;
const ready = new Promise(resolve => { resolveContext = resolve; });
const listeners = new Set();
const jobs = new Set();
addEventListener('message', event => {
  if (event.source !== parent || parent === window) return;
  if (current && event.origin !== current.parentOrigin) return;
  const message = event.data;
  if (message?.type === 'emachine:context' && message.protocol === 1) {
    current = { ...message, parentOrigin: event.origin };
    document.documentElement.dataset.theme = message.theme;
    resolveContext(current);
    for (const fn of listeners) fn(current);
  } else if (message?.type === 'emachine:job') {
    for (const fn of jobs) fn(message.job);
  }
});
if (parent !== window) parent.postMessage({ type: 'emachine:ready' }, '*');
async function request(path, options = {}) {
  const context = await ready;
  const response = await fetch(new URL(path, context.baseUrl), { credentials: 'include', cache: 'no-store', ...options });
  if (!response.ok) throw new Error((await response.text()).slice(0, 4096));
  return response.json();
}
export const emachine = {
  ready,
  context: () => current,
  onContext(fn) { listeners.add(fn); if (current) fn(current); return () => listeners.delete(fn); },
  onJob(fn) { jobs.add(fn); return () => jobs.delete(fn); },
  async run(action, input = null) {
    const c = await ready;
    return request(`api/v1/projects/${c.project.id}/features/${c.feature.id}/jobs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, input }),
    });
  },
  job(id) { if (!/^[a-z0-9-]{1,48}$/.test(id)) throw new Error('Invalid job identity'); return request(`api/v1/jobs/${id}`); },
  async artifact(path) {
    const c = await ready;
    if (!path || path.split('/').some(p => !p || p === '.' || p === '..') || path.includes('\\')) throw new Error('Invalid artifact path');
    return new URL(`api/v1/artifacts/${c.project.id}/${c.feature.id}/${path.split('/').map(encodeURIComponent).join('/')}`, c.baseUrl).href;
  },
  async report(error) {
    const c = await ready;
    parent.postMessage({ type: 'emachine:error', message: String(error).slice(0, 4096) }, c.parentOrigin);
  },
};
addEventListener('error', event => { void emachine.report(event.message); });
addEventListener('unhandledrejection', event => { void emachine.report(event.reason); });
