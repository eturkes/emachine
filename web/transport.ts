export interface Feature { id: string; title: string; revision: string; entry: string; status: 'ready' | 'stale'; updatedAt: number }
export interface Project { id: string; name: string; path: string; features: Feature[]; diagnostics: { feature: string; message: string; updatedAt: number }[] }
export interface Machine { id: string; name: string; version: string; projectRoot: string }
export interface Inventory { protocol: 1; machine: Machine; projects: Project[] }
export interface Connection { key: string; id?: string; name: string; direct: string; gateway?: string }
export interface Job { id: string; project: string; feature: string; action: string; status: string; startedAt: number; finishedAt?: number; exitCode?: number; message?: string }
const STORE = 'emachine:connections:v1';
const CACHE = 'emachine:inventory:v1:';

export function baseUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Use HTTPS, or HTTP on this device’s localhost.');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('Addresses cannot contain credentials, queries or fragments.');
  url.pathname = url.pathname.replace(/\/*$/, '/');
  return url.href;
}
export function endpoint(base: string, relative: string): string {
  const path = decodeURIComponent(relative.split(/[?#]/, 1)[0]);
  if (path.startsWith('/') || path.includes('\\') || path.split('/').includes('..') || /[\u0000-\u001f\u007f]/.test(path) || /^[a-z][a-z\d+.-]*:/i.test(relative.trimStart())) {
    throw new Error('Expected a relative machine endpoint.');
  }
  const root = new URL(baseUrl(base));
  const url = new URL(relative, root);
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) throw new Error('The endpoint escaped its machine route.');
  return url.href;
}
export function socketUrl(base: string, relative: string): string {
  const url = new URL(endpoint(base, relative));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}
export function inventory(value: unknown): Inventory {
  const v = value as Inventory;
  if (v?.protocol !== 1 || !/^[a-z0-9-]{1,48}$/.test(v.machine?.id ?? '') || typeof v.machine.name !== 'string' || !Array.isArray(v.projects)) {
    throw new Error('This address did not return an emachine v1 inventory.');
  }
  for (const project of v.projects) {
    if (!/^[a-z0-9-]{1,48}$/.test(project.id) || typeof project.name !== 'string' || !Array.isArray(project.features) || !Array.isArray(project.diagnostics)) {
      throw new Error('The machine returned an invalid project.');
    }
    for (const feature of project.features) {
      if (!/^[a-z0-9-]{1,48}$/.test(feature.id) || typeof feature.title !== 'string' || !/^[a-f0-9]{64}$/.test(feature.revision) || typeof feature.entry !== 'string') {
        throw new Error('The machine returned an invalid feature.');
      }
    }
  }
  return v;
}
function read<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback; } catch { return fallback; }
}
function store(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage can be unavailable in a private browser. */ }
}
export class Link {
  state?: Inventory;
  route?: string;
  online = false;
  error = '';
  stopped = false;
  private connecting = false;
  private ws?: WebSocket;
  private retry?: number;
  private heartbeat?: number;
  private attempts = 0;
  private seen = 0;
  private generation = 0;
  constructor(public config: Connection, private changed: () => void, private job: (link: Link, job: Job, recovered?: boolean) => void) {
    try { const cached = read<Inventory | undefined>(CACHE + config.key, undefined); if (cached) this.state = inventory(cached); } catch { /* Ignore incompatible local metadata. */ }
  }
  private accept(next: Inventory): void {
    if (this.config.id && this.config.id !== next.machine.id) throw new Error('The machine identity changed. Remove and re-add this connection after checking the address.');
    this.config.id = next.machine.id;
    this.state = next;
    // Keep only sidebar metadata. Never retain terminal output, errors, source, or job results.
    store(CACHE + this.config.key, { ...next, projects: next.projects.map(p => ({ ...p, path: '', diagnostics: [] })) });
    this.changed();
  }
  async connect(): Promise<void> {
    if (this.stopped || this.connecting) return;
    this.connecting = true;
    const generation = ++this.generation;
    window.clearTimeout(this.retry);
    const candidates = [...new Set([this.config.direct, this.config.gateway].filter(Boolean) as string[])];
    const errors: string[] = [];
    for (const candidate of candidates) {
      try {
        const base = baseUrl(candidate);
        const response = await fetch(endpoint(base, 'api/v1/state'), { credentials: 'include', signal: AbortSignal.timeout(4500), cache: 'no-store' });
        if (!response.ok) throw new Error(response.status === 403 ? 'Access denied: check the tailnet owner and allowed client origin.' : `HTTP ${response.status}`);
        const next = inventory(await response.json());
        if (this.stopped || generation !== this.generation) return;
        if (this.config.id && this.config.id !== next.machine.id) throw new Error('Machine identity mismatch.');
        this.route = base;
        this.online = true;
        this.error = '';
        this.attempts = 0;
        this.accept(next);
        this.connecting = false;
        this.openEvents(generation);
        void this.recoverJobs(base, generation);
        return;
      } catch (error) { errors.push(`${new URL(candidate).host}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (this.stopped || generation !== this.generation) return;
    this.connecting = false;
    this.online = false;
    this.error = errors.join(' · ') || 'No machine address is configured.';
    this.changed();
    this.schedule();
  }
  private async recoverJobs(base: string, generation: number): Promise<void> {
    try {
      const response = await fetch(endpoint(base, 'api/v1/jobs'), { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`Job history: HTTP ${response.status}`);
      const value = await response.json();
      if (this.stopped || generation !== this.generation) return;
      if (!Array.isArray(value.jobs)) throw new Error('Invalid job history response.');
      for (const job of value.jobs.slice(-200)) this.job(this, job, true);
    } catch (error) {
      if (!this.stopped && generation === this.generation) { this.error = String(error); this.changed(); }
    }
  }
  private openEvents(generation: number): void {
    if (!this.route || this.stopped) return;
    this.ws?.close();
    const ws = new WebSocket(socketUrl(this.route, 'api/v1/events'));
    this.ws = ws;
    this.seen = Date.now();
    ws.onmessage = event => {
      if (generation !== this.generation || this.stopped) return;
      this.seen = Date.now();
      try {
        const message = JSON.parse(String(event.data));
        if (message.type === 'inventory') this.accept(inventory(message.state));
        else if (message.type === 'job') this.job(this, message.job);
        else if (message.type === 'error') { this.error = String(message.message); this.changed(); }
      } catch (error) { this.error = error instanceof Error ? error.message : String(error); this.changed(); }
    };
    ws.onclose = () => {
      if (this.stopped || generation !== this.generation || this.ws !== ws) return;
      window.clearInterval(this.heartbeat);
      this.online = false;
      this.error ||= 'Connection lost. Reconnecting without replaying terminal input.';
      this.changed();
      this.schedule();
    };
    ws.onerror = () => ws.close();
    window.clearInterval(this.heartbeat);
    this.heartbeat = window.setInterval(() => {
      if (Date.now() - this.seen > 30000) { ws.close(); return; }
      if (ws.readyState === WebSocket.OPEN) ws.send('ping');
    }, 10000);
  }
  private schedule(): void {
    if (!this.stopped) this.retry = window.setTimeout(() => void this.connect(), Math.min(15000, 700 * 2 ** this.attempts++));
  }
  wake(): void {
    if (!this.online) void this.connect();
    else if (Date.now() - this.seen > 25000) this.ws?.close();
  }
  stop(): void {
    this.stopped = true;
    this.generation++;
    window.clearTimeout(this.retry);
    window.clearInterval(this.heartbeat);
    this.ws?.close();
  }
}
export class Fleet {
  links: Link[] = [];
  changed: () => void = () => {};
  job: (link: Link, job: Job, recovered?: boolean) => void = () => {};
  private persist(): void { store(STORE, this.links.map(link => link.config)); }
  async start(): Promise<void> {
    let connections = read<Connection[] | undefined>(STORE, undefined);
    if (!Array.isArray(connections)) {
      try {
        const response = await fetch(new URL('./bootstrap.json', location.href), { cache: 'no-store', signal: AbortSignal.timeout(3000) });
        const raw = await response.json();
        connections = (Array.isArray(raw.servers) ? raw.servers : []).map((item: Omit<Connection, 'key'>) => ({ ...item, key: crypto.randomUUID() }));
      } catch { connections = []; }
      if (!connections?.length && ['http:', 'https:'].includes(location.protocol)) {
        connections = [{ key: crypto.randomUUID(), name: 'This machine', direct: new URL('./', location.href).href }];
      }
    }
    for (const config of connections ?? []) {
      try { this.add(config, false, false); } catch { /* The settings dialog can replace obsolete saved endpoints. */ }
    }
    this.persist();
    this.changed();
    for (const link of this.links) void link.connect();
  }
  add(config: Connection, connect = true, announce = true): void {
    config = { ...config, direct: baseUrl(config.direct), gateway: config.gateway ? baseUrl(config.gateway) : undefined };
    const previous = this.links.find(link => link.config.key === config.key);
    previous?.stop();
    const link = new Link(config, () => { this.persist(); this.changed(); }, (source, job, recovered) => this.job(source, job, recovered));
    const index = previous ? this.links.indexOf(previous) : -1;
    if (index < 0) this.links.push(link); else this.links[index] = link;
    // Startup restores all cached machines before rendering can replace a saved project selection.
    if (announce) { this.persist(); this.changed(); }
    if (connect) void link.connect();
  }
  remove(key: string): void {
    this.links.find(link => link.config.key === key)?.stop();
    this.links = this.links.filter(link => link.config.key !== key);
    try { localStorage.removeItem(CACHE + key); } catch { /* Best-effort removal on storage-restricted browsers. */ }
    this.persist();
    this.changed();
  }
  unique(): Link[] {
    const result = new Map<string, Link>();
    for (const link of this.links) {
      const id = link.state?.machine.id ?? link.config.id ?? link.config.key;
      const previous = result.get(id);
      if (!previous || (!previous.online && link.online)) result.set(id, link);
    }
    return [...result.values()];
  }
}
