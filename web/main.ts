import '@fontsource-variable/atkinson-hyperlegible-next';
import '@fontsource/iosevka/400.css';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import { Fleet, Link, baseUrl, endpoint, type Connection, type Feature, type Job, type Project } from './transport';
import { TerminalPane, type Theme } from './terminal';

const $ = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const element = document.createElement(tag); element.className = className; element.textContent = text; return element;
};
const button = (text: string, action: () => void, className = '', label = text) => {
  const element = $('button', className, text); element.type = 'button'; element.setAttribute('aria-label', label); element.title = label; element.onclick = action; return element;
};
const read = <T,>(key: string, fallback: T): T => { try { return JSON.parse(localStorage.getItem('emachine:' + key) ?? 'null') ?? fallback; } catch { return fallback; } };
const save = (key: string, value: unknown) => { try { localStorage.setItem('emachine:' + key, JSON.stringify(value)); } catch { /* Private browsing may restrict storage. */ } };
const fleet = new Fleet();
let selected = read('selection', '');
let selectedTabs = read<Record<string, string>>('tabs', {});
let preference = read<'auto' | Theme>('theme', 'auto');
let collapsed = read('collapsed', false);
let theme: Theme = 'dark';
let filter = '';
let orderedProjects = read<string[]>('project-order', []);
const orderTabs = read<Record<string, string[]>>('tab-order', {});
const terminals = new Map<string, TerminalPane>();
const frames = new Map<string, FeatureFrame>();
const jobs = new Map<string, { link: Link; job: Job }>();
const app = $('div', 'app'); document.querySelector('#app')!.append(app);
const scrim = button('', () => app.classList.remove('drawer-open'), 'drawer-scrim', 'Close project drawer');
const rail = $('aside', 'project-rail'); rail.setAttribute('aria-label', 'Projects');
const brand = $('header', 'brand'); brand.append($('span', 'brand-mark', 'e'), $('div', 'brand-name', 'emachine'), button('×', () => app.classList.remove('drawer-open'), 'icon mobile-close', 'Close projects'));
const search = $('input', 'project-search'); search.type = 'search'; search.placeholder = 'Find a project'; search.setAttribute('aria-label', 'Filter projects'); search.oninput = () => { filter = search.value; renderRail(); };
const projectList = $('nav', 'project-list'); projectList.setAttribute('aria-label', 'Project list');
const railFooter = $('footer', 'rail-footer');
const machineCount = $('span', 'machine-count');
railFooter.append(button('＋ Machines', () => openSettings(), 'manage-machines'), machineCount, button('‹', () => { collapsed = !collapsed; save('collapsed', collapsed); applyRail(); }, 'icon collapse-control', 'Collapse or expand the project sidebar'));
rail.append(brand, $('div', 'rail-label', 'WORKSPACES'), search, projectList, railFooter);
const workspace = $('main', 'workspace');
const tabHeader = $('header', 'tab-header');
const mobileMenu = button('☰', () => app.classList.toggle('drawer-open'), 'icon mobile-menu', 'Open project drawer');
const tabs = $('nav', 'tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Project views');
const connectionBadge = $('span', 'connection-badge');
const jobButton = button('Jobs', () => showJobs(), 'text-button'); jobButton.hidden = true;
const themeButton = button('◐', () => { preference = preference === 'auto' ? 'dark' : preference === 'dark' ? 'light' : 'auto'; save('theme', preference); applyTheme(); }, 'icon', 'Change color theme');
const actions = $('div', 'header-actions'); actions.append(connectionBadge, jobButton, button('⌘', () => openPalette(), 'icon', 'Open command palette, Control or Command Shift P'), themeButton, button('⚙', () => openSettings(), 'icon', 'Machine settings'));
tabHeader.append(mobileMenu, tabs, actions);
const contextBar = $('div', 'context-bar');
const title = $('div', 'project-title');
const path = $('div', 'project-path');
const contextName = $('div', 'context-name'); contextName.append(title, path);
const diagnostics = $('details', 'diagnostics');
const diagnosticTitle = $('summary'); const diagnosticText = $('pre'); diagnostics.append(diagnosticTitle, diagnosticText); diagnostics.hidden = true;
contextBar.append(contextName, diagnostics);
const offline = $('div', 'offline-banner'); offline.setAttribute('role', 'status'); offline.hidden = true;
const views = $('div', 'views');
const empty = $('section', 'empty-state');
empty.append($('div', 'empty-mark', 'e'), $('p', 'eyebrow', 'A PERSONAL COMMAND CENTER'), $('h1', '', 'Your projects. Their own space.'), $('p', 'empty-copy', 'Connect a machine to discover its projects. Each workspace starts with a persistent terminal and grows through your requests to Codexify.'), button('Connect a machine', () => openSettings(), 'primary-button'));
views.append(empty); workspace.append(tabHeader, contextBar, offline, views); app.append(scrim, rail, workspace);
const toastRegion = $('div', 'toast-region'); toastRegion.setAttribute('aria-live', 'polite'); document.body.append(toastRegion);
function notice(message: string): void {
  const toast = $('div', 'toast', message); toastRegion.append(toast); window.setTimeout(() => toast.remove(), 7000);
}
function applyRail(): void { app.classList.toggle('rail-collapsed', collapsed); }
function applyTheme(): void {
  theme = preference === 'auto' ? matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' : preference;
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
  themeButton.title = `Theme: ${preference}${preference === 'auto' ? ` (${theme})` : ''}`;
  themeButton.setAttribute('aria-label', themeButton.title);
  for (const terminal of terminals.values()) terminal.theme(theme);
  for (const frame of frames.values()) frame.context();
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
applyRail(); applyTheme();
function projectKey(link: Link, project: Project): string { return `${link.state!.machine.id}:${project.id}`; }
function entries(): { key: string; link: Link; project: Project }[] {
  const result = fleet.unique().flatMap(link => (link.state?.projects ?? []).map(project => ({ key: projectKey(link, project), link, project })));
  const position = (key: string) => { const index = orderedProjects.indexOf(key); return index < 0 ? 100000 : index; };
  return result.sort((a, b) => position(a.key) - position(b.key) || a.project.name.localeCompare(b.project.name) || a.link.config.name.localeCompare(b.link.config.name));
}
function choose(key: string, tab?: string): void {
  selected = key; save('selection', key);
  if (tab) { selectedTabs[key] = tab; save('tabs', selectedTabs); }
  app.classList.remove('drawer-open'); render();
}
let draggedProject = '';
function renderRail(): void {
  const scroll = projectList.scrollTop; projectList.replaceChildren();
  const items = entries().filter(({ project, link }) => `${project.name} ${link.state?.machine.name} ${link.config.name}`.toLowerCase().includes(filter.toLowerCase()));
  for (const item of items) {
    const b = button('', () => choose(item.key), `project-item${item.key === selected ? ' active' : ''}`, `${item.project.name} on ${item.link.state!.machine.name}, ${item.link.online ? 'online' : 'offline'}`);
    b.dataset.projectKey = item.key; b.setAttribute('aria-current', item.key === selected ? 'page' : 'false'); b.draggable = true;
    const glyph = $('span', 'project-glyph', Array.from(item.project.name)[0]?.toUpperCase() ?? '·');
    glyph.append($('span', `availability ${item.link.online ? 'online' : 'offline'}`));
    const copy = $('span', 'project-copy'); copy.append($('strong', '', item.project.name), $('small', '', item.link.state!.machine.name));
    b.append(glyph, copy);
    b.ondragstart = event => { draggedProject = item.key; event.dataTransfer?.setData('text/plain', item.key); };
    b.ondragover = event => event.preventDefault();
    b.ondrop = event => { event.preventDefault(); if (!draggedProject || draggedProject === item.key) return; orderedProjects = entries().map(e => e.key).filter(key => key !== draggedProject); orderedProjects.splice(orderedProjects.indexOf(item.key), 0, draggedProject); save('project-order', orderedProjects); draggedProject = ''; renderRail(); };
    projectList.append(b);
  }
  if (!items.length) projectList.append($('p', 'rail-empty', filter ? 'No matching projects' : 'No projects discovered'));
  for (const link of fleet.unique().filter(link => !link.state)) {
    const pending = $('div', 'machine-pending'); pending.append($('strong', '', link.config.name), $('small', '', link.error || 'Connecting…')); projectList.append(pending);
  }
  projectList.scrollTop = scroll;
  const count = fleet.unique(); machineCount.textContent = `${count.filter(link => link.online).length} of ${count.length} machines online`;
}
class FeatureFrame {
  element = $('iframe', 'feature-frame view');
  private url = '';
  private errorMessage = '';
  constructor(public link: Link, public project: Project, public feature: Feature) {
    this.element.title = `${feature.title} — ${project.name}`;
    this.element.allow = 'camera; microphone'; this.element.referrerPolicy = 'no-referrer';
    this.element.onload = () => this.context();
    this.update(link, project, feature);
  }
  update(link: Link, project: Project, feature: Feature): void {
    this.link = link; this.project = project; this.feature = feature;
    if (!link.online || !link.route) return;
    const next = endpoint(link.route, feature.entry);
    if (next !== this.url) { this.url = next; this.errorMessage = ''; this.element.src = next; }
    else this.context();
  }
  context(): void {
    if (!this.url || !this.link.state) return;
    this.element.contentWindow?.postMessage({ type: 'emachine:context', protocol: 1, machine: this.link.state.machine, project: this.project, feature: this.feature, baseUrl: this.link.route, theme }, new URL(this.url).origin);
  }
  receive(event: MessageEvent): void {
    if (event.source !== this.element.contentWindow || !this.url || event.origin !== new URL(this.url).origin) return;
    if (event.data?.type === 'emachine:ready') this.context();
    if (event.data?.type === 'emachine:error' && typeof event.data.message === 'string') {
      const message = event.data.message.slice(0, 4096);
      if (message === this.errorMessage) return;
      this.errorMessage = message; notice(`${this.feature.title}: ${message}`);
      if (this.link.online && this.link.route) void fetch(endpoint(this.link.route, `api/v1/projects/${this.project.id}/features/${this.feature.id}/errors`), { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: this.feature.revision, message }) }).catch(() => {});
    }
  }
  job(job: Job): void {
    if (this.url) this.element.contentWindow?.postMessage({ type: 'emachine:job', job }, new URL(this.url).origin);
  }
  dispose(): void { this.element.remove(); }
}
window.addEventListener('message', event => { for (const frame of frames.values()) frame.receive(event); });
function render(): void {
  const items = entries();
  if (!items.some(item => item.key === selected)) { selected = items[0]?.key ?? ''; save('selection', selected); }
  renderRail();
  const valid = new Set(items.map(item => item.key));
  for (const [key, terminal] of terminals) if (!valid.has(key)) { terminal.dispose(); terminals.delete(key); }
  for (const [key, frame] of frames) {
    const item = items.find(item => item.key === projectKey(frame.link, frame.project));
    if (!item || !item.project.features.some(feature => feature.id === frame.feature.id)) { frame.dispose(); frames.delete(key); }
  }
  for (const item of items) {
    terminals.get(item.key)?.update(item.link, item.project);
    for (const feature of item.project.features) frames.get(`${item.key}:${feature.id}`)?.update(item.link, item.project, feature);
  }
  const active = items.find(item => item.key === selected);
  empty.hidden = Boolean(active); contextBar.hidden = !active;
  tabs.replaceChildren();
  for (const terminal of terminals.values()) terminal.show(false);
  for (const frame of frames.values()) frame.element.hidden = true;
  if (!active) { title.textContent = ''; path.textContent = ''; offline.hidden = true; connectionBadge.textContent = fleet.links.length ? 'Connecting' : 'No machines'; return; }
  const { link, project, key } = active;
  title.textContent = project.name; path.textContent = project.path || `${link.state!.machine.name} · last known workspace`;
  connectionBadge.textContent = link.online ? link.route === link.config.gateway ? 'Gateway' : 'Direct' : 'Offline';
  connectionBadge.className = `connection-badge ${link.online ? 'connected' : 'disconnected'}`;
  connectionBadge.title = link.route ?? link.config.direct;
  offline.hidden = link.online;
  offline.textContent = `${link.state!.machine.name} is offline. Its projects remain listed. ${link.error}`;
  diagnostics.hidden = !project.diagnostics.length;
  diagnosticTitle.textContent = `${project.diagnostics.length} feature ${project.diagnostics.length === 1 ? 'issue' : 'issues'}`;
  diagnosticText.textContent = project.diagnostics.map(d => `${d.feature}\n${d.message}`).join('\n\n');
  const features = [{ id: 'terminal', title: 'Terminal', status: 'ready' }, ...project.features];
  const previous = orderTabs[key] ?? [];
  features.sort((a, b) => { const index = (id: string) => { const n = previous.indexOf(id); return n < 0 ? (id === 'terminal' ? -1 : 10000) : n; }; return index(a.id) - index(b.id); });
  let tab = selectedTabs[key] ?? 'terminal';
  if (!features.some(feature => feature.id === tab)) tab = 'terminal';
  selectedTabs[key] = tab;
  let draggedTab = '';
  for (const feature of features) {
    const b = button(feature.id === 'terminal' ? '›_  Terminal' : feature.title, () => choose(key, feature.id), `tab${feature.id === tab ? ' active' : ''}`);
    b.dataset.tabId = feature.id; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(feature.id === tab));
    if (feature.status === 'stale') { const stale = $('span', 'stale-indicator', '•'); stale.title = 'Analysis is not current. Any last result is retained until analysis runs again.'; b.append(stale); }
    b.draggable = true; b.ondragstart = () => { draggedTab = feature.id; }; b.ondragover = event => event.preventDefault();
    b.ondrop = event => { event.preventDefault(); if (!draggedTab || draggedTab === feature.id) return; const order = features.map(feature => feature.id).filter(id => id !== draggedTab); order.splice(order.indexOf(feature.id), 0, draggedTab); orderTabs[key] = order; save('tab-order', orderTabs); render(); };
    tabs.append(b);
  }
  if (tab === 'terminal') {
    let terminal = terminals.get(key);
    if (!terminal && link.online) { terminal = new TerminalPane(link, project, theme, notice); terminals.set(key, terminal); views.append(terminal.element); }
    terminal?.show(true);
  } else {
    const feature = project.features.find(feature => feature.id === tab)!;
    const frameKey = `${key}:${feature.id}`;
    let frame = frames.get(frameKey);
    if (!frame && link.online) { frame = new FeatureFrame(link, project, feature); frames.set(frameKey, frame); views.append(frame.element); }
    if (frame) frame.element.hidden = false;
  }
  const running = [...jobs.values()].filter(record => record.job.status === 'running').length;
  jobButton.hidden = !jobs.size; jobButton.textContent = running ? `${running} running` : 'Jobs';
}
fleet.changed = render;
fleet.job = (link, job, recovered = false) => {
  const key = `${link.state?.machine.id}:${job.id}`;
  const previous = jobs.get(key)?.job;
  if (previous?.finishedAt && (!job.finishedAt || job.finishedAt < previous.finishedAt)) return;
  jobs.set(key, { link, job });
  if (jobs.size > 200) jobs.delete(jobs.keys().next().value!);
  frames.get(`${link.state?.machine.id}:${job.project}:${job.feature}`)?.job(job);
  if (!recovered && job.status === 'failed') notice(`${job.feature}: ${job.message ?? `action exited with ${job.exitCode}`}`);
  render();
};
function dialog(title: string): HTMLDialogElement {
  const d = $('dialog', 'dialog'); const header = $('header', 'dialog-header'); header.append($('h2', '', title), button('×', () => d.close(), 'icon', 'Close dialog')); d.append(header); document.body.append(d);
  d.onclose = () => d.remove(); d.addEventListener('click', event => { if (event.target === d) { const r = d.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) d.close(); } }); return d;
}
function openSettings(edit?: Connection): void {
  const d = dialog('Machines');
  d.append($('p', 'dialog-copy', 'Connect directly through Tailscale. An authenticated web gateway is an optional second route. Each machine keeps its own projects.'));
  const list = $('div', 'connection-list');
  for (const link of fleet.links) {
    const row = $('div', 'connection-row'); const copy = $('div'); copy.append($('strong', '', link.config.name), $('small', '', link.config.direct), $('small', link.online ? 'online-text' : 'muted', link.online ? `Connected through ${link.route}` : link.error || 'Connecting…'));
    row.append(copy, button('Edit', () => { d.close(); openSettings(link.config); }, 'text-button'), button('Remove', () => { fleet.remove(link.config.key); d.close(); openSettings(); }, 'text-button danger-text')); list.append(row);
  }
  d.append(list, $('h3', '', edit ? 'Edit connection' : 'Add a machine'));
  const form = $('form', 'connection-form');
  const field = (label: string, name: string, value: string, placeholder: string) => { const l = $('label', '', label); const i = $('input'); i.name = name; i.value = value; i.placeholder = placeholder; i.autocomplete = 'off'; l.append(i); form.append(l); return i; };
  const name = field('Name', 'name', edit?.name ?? '', 'My workstation'); name.required = true;
  const direct = field('Direct address', 'direct', edit?.direct ?? '', 'https://machine.tailnet.ts.net:4743/'); direct.required = true; direct.type = 'url';
  const gateway = field('Gateway address (optional)', 'gateway', edit?.gateway ?? '', 'https://emachine.example/m/machine-id/'); gateway.type = 'url';
  const error = $('p', 'form-error'); error.setAttribute('role', 'alert');
  const submit = $('button', 'primary-button', edit ? 'Save connection' : 'Connect machine'); submit.type = 'submit'; form.append(error, submit);
  form.onsubmit = event => { event.preventDefault(); try { fleet.add({ key: edit?.key ?? crypto.randomUUID(), id: edit?.id, name: name.value.trim(), direct: baseUrl(direct.value.trim()), gateway: gateway.value.trim() ? baseUrl(gateway.value.trim()) : undefined }); d.close(); } catch (cause) { error.textContent = cause instanceof Error ? cause.message : String(cause); } };
  d.append(form, $('p', 'origin-note', `Client origin: ${location.origin}. Each machine must allow this origin. The desktop origin is emachine://app.`));
  d.showModal();
}
function openPalette(): void {
  const d = dialog('Go to a workspace or view'); d.classList.add('palette');
  const input = $('input', 'palette-search'); input.placeholder = 'Search projects and views'; input.setAttribute('aria-label', 'Search commands');
  const results = $('div', 'palette-results'); d.append(input, results);
  const update = () => {
    results.replaceChildren(); const query = input.value.toLowerCase();
    for (const item of entries()) {
      const choices = [{ id: 'terminal', title: 'Terminal' }, ...item.project.features];
      for (const view of choices) if (`${item.project.name} ${item.link.state!.machine.name} ${view.title}`.toLowerCase().includes(query)) {
        results.append(button(`${item.project.name} / ${view.title} · ${item.link.state!.machine.name}`, () => { d.close(); choose(item.key, view.id); }, 'palette-result'));
      }
    }
  };
  input.oninput = update; input.onkeydown = event => { if (event.key === 'Enter') results.querySelector('button')?.click(); if (event.key === 'ArrowDown') { event.preventDefault(); results.querySelector('button')?.focus(); } };
  update(); d.showModal(); input.focus();
}
function showJobs(): void {
  const d = dialog('Project jobs');
  for (const { link, job } of [...jobs.values()].reverse()) {
    const row = $('div', 'job-row'); row.append($('strong', '', `${job.feature} / ${job.action}`), $('small', '', `${link.state?.machine.name ?? link.config.name} · ${job.status}`));
    if (job.message) row.append($('p', '', job.message));
    row.append(button('Read log', () => {
      if (!link.route) return;
      void fetch(endpoint(link.route, `api/v1/jobs/${job.id}/log`), { credentials: 'include', cache: 'no-store' }).then(async response => { if (!response.ok) throw new Error(`HTTP ${response.status}`); const pre = $('pre', 'job-log', await response.text()); row.querySelector('pre')?.remove(); row.append(pre); }).catch(error => notice(String(error)));
    }, 'text-button')); d.append(row);
  }
  d.showModal();
}
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'p') { event.preventDefault(); openPalette(); }
  if (event.altKey && /^[1-9]$/.test(event.key) && !document.querySelector('dialog[open]')) { const item = entries()[Number(event.key) - 1]; if (item) { event.preventDefault(); choose(item.key); } }
});
function wake(): void { if (!document.hidden) { for (const link of fleet.links) link.wake(); for (const terminal of terminals.values()) terminal.wake(); } }
document.addEventListener('visibilitychange', wake); window.addEventListener('online', wake); window.addEventListener('pageshow', wake);
const viewport = () => document.documentElement.style.setProperty('--app-height', `${visualViewport?.height ?? innerHeight}px`);
visualViewport?.addEventListener('resize', viewport); window.addEventListener('resize', viewport); viewport();
void fleet.start().catch(error => notice(String(error)));
if ('serviceWorker' in navigator && ['https:', 'http:'].includes(location.protocol)) {
  navigator.serviceWorker.register(new URL('./sw.js', location.href), { scope: './' }).catch(() => {});
}
