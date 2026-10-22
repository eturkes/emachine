import '@fontsource-variable/atkinson-hyperlegible-next';
import '@fontsource/iosevka/400.css';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import { Fleet, Link, baseUrl, endpoint, type Connection, type Feature, type Job, type Project } from './transport';
import { TerminalPane, type Theme } from './terminal';
import { restoreGeneralTabs, type GeneralTabs } from './general';
import { attachInterfaceUpdates } from './interface';

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
const savedTheme = read<unknown>('theme', null);
let theme: Theme = savedTheme === 'light' || savedTheme === 'dark' ? savedTheme : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
save('theme', theme);
let filter = '';
let orderedProjects = read<string[]>('project-order', []);
const orderTabs = read<Record<string, string[]>>('tab-order', {});
const generalTabs = restoreGeneralTabs(read<unknown>('general-tabs', {}));
const terminals = new Map<string, TerminalPane>();
const frames = new Map<string, FeatureFrame>();
const jobs = new Map<string, { link: Link; job: Job }>();
const app = $('div', 'app'); document.querySelector('#app')!.append(app);
const scrim = button('', () => app.classList.remove('drawer-open'), 'drawer-scrim', 'Close project drawer');
const rail = $('aside', 'project-rail'); rail.setAttribute('aria-label', 'Projects');
const brand = $('header', 'brand'); brand.append($('div', 'brand-name', 'emachine'), button('Close', () => app.classList.remove('drawer-open'), 'text-button mobile-close', 'Close projects'));
const search = $('input', 'project-search'); search.type = 'search'; search.placeholder = 'Find a project'; search.setAttribute('aria-label', 'Filter projects'); search.oninput = () => { filter = search.value; renderRail(); };
const projectList = $('nav', 'project-list'); projectList.setAttribute('aria-label', 'Project list');
const generalList = $('nav', 'general-list'); generalList.setAttribute('aria-label', 'General terminals');
const railFooter = $('footer', 'rail-footer');
const machineCount = $('span', 'machine-count');
railFooter.append(button('Machines', () => openSettings(), 'manage-machines'), machineCount);
rail.append(brand, generalList, $('div', 'rail-label', 'PROJECTS'), search, projectList, railFooter);
const workspace = $('main', 'workspace');
const tabHeader = $('header', 'tab-header');
const mobileMenu = button('Projects', () => app.classList.toggle('drawer-open'), 'text-button mobile-menu', 'Open project drawer');
const tabs = $('nav', 'tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Project views');
const newGeneral = button('+', () => addGeneralTerminal(), 'new-terminal', 'New General terminal'); newGeneral.hidden = true;
const themeButton = button('', () => { theme = theme === 'dark' ? 'light' : 'dark'; save('theme', theme); applyTheme(); }, 'text-button');
const actions = $('div', 'header-actions'); actions.append(themeButton, button('Settings', () => openSettings(), 'text-button', 'Machine settings'));
attachInterfaceUpdates(actions, dialog, () => fleet.links[0]?.config.direct ?? '');
tabHeader.append(mobileMenu, tabs, newGeneral, actions);
const diagnostics = $('details', 'diagnostics');
const diagnosticTitle = $('summary'); const diagnosticText = $('pre'); diagnostics.append(diagnosticTitle, diagnosticText); diagnostics.hidden = true;
actions.append(diagnostics);
const offline = $('div', 'offline-banner'); offline.setAttribute('role', 'status'); offline.hidden = true;
const views = $('div', 'views');
const empty = $('section', 'empty-state');
const generalEmpty = $('section', 'general-empty'); generalEmpty.hidden = true;
generalEmpty.append($('h1', '', 'No open terminals'), $('p', 'empty-copy', 'Your sessions remain on the machine. Open general again or use + for another terminal.'), button('Open general', () => chooseGeneral(selected, 'general'), 'primary-button'));
empty.append($('p', 'eyebrow', 'A PERSONAL COMMAND CENTER'), $('h1', '', 'Your projects. Their own space.'), $('p', 'empty-copy', 'Connect a machine to discover its projects. Each workspace starts with a persistent terminal and grows through your requests to Codexify.'), button('Connect a machine', () => openSettings(), 'primary-button'));
views.append(empty, generalEmpty); workspace.append(tabHeader, offline, views); app.append(scrim, rail, workspace);
const toastRegion = $('div', 'toast-region'); toastRegion.setAttribute('aria-live', 'polite'); document.body.append(toastRegion);
function notice(message: string): void {
  const toast = $('div', 'toast', message); toastRegion.append(toast); window.setTimeout(() => toast.remove(), 7000);
}
function applyTheme(): void {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
  themeButton.textContent = theme === 'dark' ? 'Dark' : 'Light';
  themeButton.title = `Theme: ${theme}. Switch to ${theme === 'dark' ? 'light' : 'dark'}.`;
  themeButton.setAttribute('aria-label', themeButton.title);
  for (const terminal of terminals.values()) terminal.theme(theme);
  for (const frame of frames.values()) frame.context();
}
applyTheme();
function projectKey(link: Link, project: Project): string { return `${link.state!.machine.id}:${project.id}`; }
function generalEntries(): { key: string; link: Link }[] {
  return fleet.unique().filter(link => link.state).map(link => ({ key: `${link.state!.machine.id}:@general`, link }));
}
function generalState(key: string): GeneralTabs { return generalTabs[key] ??= { sessions: ['general'], next: 2 }; }
function chooseGeneral(key: string, session?: string): void {
  const state = generalState(key);
  if (!state.sessions.length) { state.sessions.push('general'); save('general-tabs', generalTabs); }
  choose(key, session);
}
function focusGeneralTab(): void {
  const active = tabs.querySelector<HTMLButtonElement>('[aria-selected="true"]');
  (active ?? newGeneral).focus();
  active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function addGeneralTerminal(): void {
  if (!generalEntries().some(item => item.key === selected)) return;
  const state = generalState(selected);
  if (state.next >= Number.MAX_SAFE_INTEGER) return;
  const session = `general${state.next++}`;
  state.sessions.push(session); save('general-tabs', generalTabs);
  choose(selected, session); focusGeneralTab();
}
function closeGeneralTerminal(key: string, session: string): void {
  const state = generalState(key), index = state.sessions.indexOf(session);
  if (index < 0) return;
  state.sessions.splice(index, 1); save('general-tabs', generalTabs);
  if (selectedTabs[key] === session) {
    selectedTabs[key] = state.sessions[Math.min(index, state.sessions.length - 1)] ?? '';
    save('tabs', selectedTabs);
  }
  render(); focusGeneralTab();
}
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
  const generalScroll = generalList.scrollTop; generalList.replaceChildren();
  for (const { key, link } of generalEntries()) {
    const b = button('', () => chooseGeneral(key), `general-item${key === selected ? ' active' : ''}`, `General on ${link.state!.machine.name}, ${link.online ? 'online' : 'offline'}`);
    b.dataset.generalKey = key; b.setAttribute('aria-current', key === selected ? 'page' : 'false');
    const mark = $('span', 'general-mark', '>_'); mark.setAttribute('aria-hidden', 'true');
    const copy = $('span', 'general-copy'); copy.append($('strong', '', 'General'), $('small', '', link.state!.machine.name));
    b.append(mark, copy); generalList.append(b);
  }
  generalList.hidden = !generalList.childElementCount; generalList.scrollTop = generalScroll;
  const scroll = projectList.scrollTop; projectList.replaceChildren();
  const items = entries().filter(({ project, link }) => `${project.name} ${link.state?.machine.name} ${link.config.name}`.toLowerCase().includes(filter.toLowerCase()));
  for (const item of items) {
    const phase = item.project.phase ? item.project.phase[0] + item.project.phase.slice(1).toLowerCase() : '';
    const status = item.link.online ? item.project.claudeStatus : null;
    const activity = status ? { working: 'Working', completed: 'Completed', waiting: 'Waiting' }[status] : '';
    const description = status ? { working: 'Claude Code is working.', completed: 'Claude Code is idle and ready for another prompt.', waiting: 'Claude Code is waiting for input.' }[status] : '';
    const b = button('', () => choose(item.key), `project-item${item.key === selected ? ' active' : ''}`, `${item.project.name} on ${item.link.state!.machine.name}, ${item.link.online ? 'online' : 'offline'}${phase ? `, phase: ${phase}` : ''}${status ? `, Claude Code: ${activity}${status === 'waiting' ? ' for input' : ''}` : ''}`);
    b.dataset.projectKey = item.key; b.setAttribute('aria-current', item.key === selected ? 'page' : 'false'); b.draggable = true;
    const copy = $('span', 'project-copy');
    const heading = $('span', 'project-heading'); heading.append($('strong', '', item.project.name));
    if (phase) {
      const label = $('span', 'project-phase', phase);
      label.title = phase === 'Unknown' ? 'No single supported phase is readable in .agent/spec.md.' : `Recorded phase in .agent/spec.md: ${phase}`;
      heading.append(label);
    }
    const machine = $('small', '', item.link.state!.machine.name);
    copy.append(heading);
    if (status) {
      b.dataset.claudeStatus = status;
      const meta = $('span', 'project-meta');
      const indicator = $('span', 'claude-status'); indicator.title = description;
      const icon = $('span', 'claude-status-icon'); icon.setAttribute('aria-hidden', 'true');
      indicator.append(icon, $('span', '', activity));
      meta.append(machine, indicator); copy.append(meta);
    } else copy.append(machine);
    b.append(copy);
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
function renderGeneral({ key, link }: { key: string; link: Link }): void {
  const state = generalState(key);
  const session = state.sessions.includes(selectedTabs[key]) ? selectedTabs[key] : state.sessions[0] ?? '';
  if (selectedTabs[key] !== session) { selectedTabs[key] = session; save('tabs', selectedTabs); }
  tabs.setAttribute('aria-label', 'General terminal tabs');
  newGeneral.hidden = false; newGeneral.disabled = state.next >= Number.MAX_SAFE_INTEGER;
  diagnostics.hidden = true; generalEmpty.hidden = state.sessions.length > 0;
  for (const name of state.sessions) {
    const group = $('div', `general-tab${name === session ? ' active' : ''}`); group.setAttribute('role', 'presentation');
    const b = button(name, () => { choose(key, name); focusGeneralTab(); }, `tab${name === session ? ' active' : ''}`);
    b.dataset.tabId = name; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(name === session)); b.tabIndex = name === session ? 0 : -1;
    b.id = `general-tab-${link.state!.machine.id}-${name}`; b.setAttribute('aria-controls', `general-pane-${link.state!.machine.id}-${name}`);
    b.onkeydown = event => {
      const index = state.sessions.indexOf(name);
      const next = event.key === 'ArrowRight' ? (index + 1) % state.sessions.length : event.key === 'ArrowLeft' ? (index - 1 + state.sessions.length) % state.sessions.length : event.key === 'Home' ? 0 : event.key === 'End' ? state.sessions.length - 1 : -1;
      if (next >= 0) { event.preventDefault(); choose(key, state.sessions[next]); focusGeneralTab(); }
      else if (event.key === 'Delete') { event.preventDefault(); closeGeneralTerminal(key, name); }
    };
    const close = button('×', () => closeGeneralTerminal(key, name), 'close-terminal', `Close ${name}`);
    close.tabIndex = name === session ? 0 : -1;
    close.title = `Close ${name} tab. The session stays on the machine.`;
    group.append(b, close); tabs.append(group);
  }
  if (!session) return;
  const terminalKey = `${key}:${session}`;
  let terminal = terminals.get(terminalKey);
  if (!terminal && link.online) {
    terminal = new TerminalPane(link, { kind: 'general', session }, theme, notice);
    terminal.element.id = `general-pane-${link.state!.machine.id}-${session}`;
    terminal.element.setAttribute('role', 'tabpanel'); terminal.element.setAttribute('aria-labelledby', `general-tab-${link.state!.machine.id}-${session}`);
    terminals.set(terminalKey, terminal); views.append(terminal.element);
  }
  terminal?.show(true);
}
function render(): void {
  const items = entries(), generals = generalEntries();
  if (![...items, ...generals].some(item => item.key === selected)) { selected = items[0]?.key ?? generals[0]?.key ?? ''; save('selection', selected); }
  renderRail();
  const valid = new Set([...items.map(item => item.key), ...generals.flatMap(item => generalState(item.key).sessions.map(session => `${item.key}:${session}`))]);
  for (const [key, terminal] of terminals) if (!valid.has(key)) { terminal.dispose(); terminals.delete(key); }
  for (const [key, frame] of frames) {
    const item = items.find(item => item.key === projectKey(frame.link, frame.project));
    if (!item || !item.project.features.some(feature => feature.id === frame.feature.id)) { frame.dispose(); frames.delete(key); }
  }
  for (const item of items) {
    terminals.get(item.key)?.update(item.link, { kind: 'project', id: item.project.id });
    for (const feature of item.project.features) frames.get(`${item.key}:${feature.id}`)?.update(item.link, item.project, feature);
  }
  for (const item of generals) for (const session of generalState(item.key).sessions) terminals.get(`${item.key}:${session}`)?.update(item.link, { kind: 'general', session });
  const active = items.find(item => item.key === selected);
  const general = generals.find(item => item.key === selected);
  empty.hidden = Boolean(active || general); generalEmpty.hidden = true;
  tabHeader.classList.toggle('general-view', Boolean(general)); newGeneral.hidden = true;
  tabs.setAttribute('aria-label', 'Project views');
  tabs.replaceChildren();
  for (const terminal of terminals.values()) terminal.show(false);
  for (const frame of frames.values()) frame.element.hidden = true;
  if (!active && !general) { diagnostics.hidden = true; offline.hidden = true; return; }
  const activeLink = (active ?? general)!.link;
  offline.hidden = activeLink.online;
  offline.textContent = `${activeLink.state!.machine.name} is offline. Its workspaces remain listed. ${activeLink.error}`;
  if (general) { renderGeneral(general); return; }
  if (!active) return;
  const { link, project, key } = active;
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
    const b = button(feature.title, () => choose(key, feature.id), `tab${feature.id === tab ? ' active' : ''}`);
    b.dataset.tabId = feature.id; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(feature.id === tab));
    if (feature.status === 'stale') { const stale = $('span', 'stale-indicator', 'Stale'); stale.title = 'Analysis is not current. Any last result is retained until analysis runs again.'; b.append(stale); }
    b.draggable = true; b.ondragstart = () => { draggedTab = feature.id; }; b.ondragover = event => event.preventDefault();
    b.ondrop = event => { event.preventDefault(); if (!draggedTab || draggedTab === feature.id) return; const order = features.map(feature => feature.id).filter(id => id !== draggedTab); order.splice(order.indexOf(feature.id), 0, draggedTab); orderTabs[key] = order; save('tab-order', orderTabs); render(); };
    tabs.append(b);
  }
  if (tab === 'terminal') {
    let terminal = terminals.get(key);
    if (!terminal && link.online) { terminal = new TerminalPane(link, { kind: 'project', id: project.id }, theme, notice); terminals.set(key, terminal); views.append(terminal.element); }
    terminal?.show(true);
  } else {
    const feature = project.features.find(feature => feature.id === tab)!;
    const frameKey = `${key}:${feature.id}`;
    let frame = frames.get(frameKey);
    if (!frame && link.online) { frame = new FeatureFrame(link, project, feature); frames.set(frameKey, frame); views.append(frame.element); }
    if (frame) frame.element.hidden = false;
  }
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
    for (const item of generalEntries()) {
      const sessions = generalState(item.key).sessions;
      for (const session of sessions.length ? sessions : ['general']) if (`General ${item.link.state!.machine.name} ${session}`.toLowerCase().includes(query)) {
        results.append(button(`General / ${session} · ${item.link.state!.machine.name}`, () => { d.close(); chooseGeneral(item.key, session); }, 'palette-result'));
      }
    }
    for (const item of entries()) {
      const choices = [{ id: 'terminal', title: 'Terminal' }, ...item.project.features];
      for (const view of choices) if (`${item.project.name} ${item.link.state!.machine.name} ${view.title}`.toLowerCase().includes(query)) {
        results.append(button(`${item.project.name} / ${view.title} · ${item.link.state!.machine.name}`, () => { d.close(); choose(item.key, view.id); }, 'palette-result'));
      }
    }
  };
  input.oninput = update; input.onkeydown = event => {
    // Closing restores focus to the opener; consume Enter before it activates that button again.
    if (event.key === 'Enter') { event.preventDefault(); results.querySelector('button')?.click(); }
    if (event.key === 'ArrowDown') { event.preventDefault(); results.querySelector('button')?.focus(); }
  };
  update(); d.showModal(); input.focus();
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
// Only a fully initialized shell confirms a staged UI; the preload binds this to its document.
void window.emachineInterface?.ready().catch(() => {});
