import { readFile, writeFile, mkdir, rename, chmod, realpath, rm, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { request } from 'node:http';
import { ensureCaddy } from './caddy.mjs';
import { gatewayConfig, publicAddress } from './phone-gateway.mjs';
import { withFileLock } from './phone-lock.mjs';

const exec = promisify(execFile);
const marker = '# emachine phone gateway managed';
const service = 'emachine-phone.service';
const publicPort = 8443, listenPort = 4738;
const unitQuote = value => '"' + value.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
async function optional(path) { try { return await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } }
async function atomic(path, text, mode = 0o600) {
  const temporary = path + '.pending-' + randomUUID();
  try { await writeFile(temporary, text, { mode }); await rename(temporary, path); await chmod(path, mode); }
  finally { await rm(temporary, { force: true }); }
}
async function status() { return JSON.parse((await exec('tailscale', ['serve', 'status', '--json'])).stdout); }
export function route(config, installed) {
  const authority = new URL(installed.publicUrl).host;
  const web = config.Web?.[authority];
  const mentionsPort = value => !!value.TCP?.[publicPort] || ['Web', 'AllowFunnel'].some(key => Object.keys(value[key] ?? {}).some(host => host.endsWith(`:${publicPort}`)));
  const foreground = value => Object.values(value.Foreground ?? {}).some(child => mentionsPort(child) || foreground(child));
  if (foreground(config)) throw new Error(`Port ${publicPort} belongs to another foreground Tailscale route. Stop its owner before using phone access.`);
  const occupied = mentionsPort(config);
  const owned = config.TCP?.[publicPort]?.HTTPS === true && Object.keys(config.TCP[publicPort]).length === 1 &&
    isDeepStrictEqual(web, { Handlers: { '/': { Proxy: `http://127.0.0.1:${installed.listenPort}` } } }) &&
    Object.keys(config.Web ?? {}).filter(key => key.endsWith(`:${publicPort}`)).length === 1 &&
    Object.keys(config.AllowFunnel ?? {}).filter(key => key.endsWith(`:${publicPort}`)).every(key => key === authority);
  if (occupied && !owned) throw new Error(`Port ${publicPort} belongs to another Tailscale route. It was not changed.`);
  return { authority, occupied, published: owned && config.AllowFunnel?.[authority] === true };
}
export function unrelated(config, authority) {
  const copy = structuredClone(config);
  for (const [key, entry] of [['TCP', String(publicPort)], ['Web', authority], ['AllowFunnel', authority]]) {
    if (copy[key]) { delete copy[key][entry]; if (!Object.keys(copy[key]).length) delete copy[key]; }
  }
  return copy;
}
function localRequest(installed, path, password, cookie) {
  const address = new URL(installed.publicUrl);
  return new Promise((resolve, reject) => {
    const headers = { Host: address.host, Origin: address.origin };
    if (password) headers.Authorization = 'Basic ' + Buffer.from(`emachine:${password}`).toString('base64');
    if (cookie) headers.Cookie = cookie;
    const req = request(`http://127.0.0.1:${installed.listenPort}/${path}`, { headers, timeout: 10000 }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) res.destroy(new Error('Gateway response exceeds its limit.')); else chunks.push(chunk); });
      res.on('error', reject); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString(), cookies: res.headers['set-cookie'] ?? [] }));
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('The gateway did not respond.'))); req.end();
  });
}
async function probe(installed, password) {
  for (const path of ['', 'bootstrap.json', 'api/v1/state', 'api/v1/events']) {
    if ((await localRequest(installed, path)).status !== 401) throw new Error('The gateway did not reject anonymous access. Publication is blocked.');
  }
  const response = await localRequest(installed, 'api/v1/state', password);
  if (response.status !== 200 || JSON.parse(response.body).machine?.id !== installed.machine.id) throw new Error('Authenticated machine access failed. Publication is blocked.');
  if (installed.sessionSocket) {
    const cookie = response.cookies.find(value => value.startsWith('__Host-emachine-phone='));
    if (!cookie || !cookie.includes('; Secure') || !cookie.includes('; HttpOnly') || !cookie.includes('; SameSite=Strict')) throw new Error('The protected browser session was not established.');
    const resumed = await localRequest(installed, 'api/v1/state', undefined, cookie.split(';')[0]);
    if (resumed.status !== 200 || JSON.parse(resumed.body).machine?.id !== installed.machine.id) throw new Error('Cookie-only machine access failed.');
  }
  const seed = await localRequest(installed, 'bootstrap.json', password);
  if (seed.status !== 200 || JSON.parse(seed.body).servers?.[0]?.direct !== installed.publicUrl) throw new Error('The public client seed is incorrect. Publication is blocked.');
}
async function active() { return (await exec('systemctl', ['--user', 'is-active', service]).catch(() => ({ stdout: 'inactive' }))).stdout.trim(); }
async function funnel(args) {
  // The privileged operation is limited to this port. Tailnet approval remains an interactive Tailscale decision.
  const child = spawn('sudo', ['-n', 'tailscale', 'funnel', `--https=${publicPort}`, ...args], { stdio: 'inherit' });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Tailscale did not enable the requested route.'))); });
}

async function main(action) {
  if (!['install', 'enable', 'disable', 'status'].includes(action)) {
    console.log('Usage: node scripts/phone-access.mjs install|enable|disable|status\nInstall prepares a password-protected loopback gateway. Enable publishes only port 8443.');
    return;
  }
  const home = await realpath(homedir());
  const configHome = process.env.XDG_CONFIG_HOME || join(home, '.config');
  const configPath = await realpath(process.env.EMACHINE_CONFIG || join(configHome, 'emachine/config.json'));
  const directory = join(dirname(configPath), 'phone');
  const settingsPath = join(directory, 'settings.json'), passwordPath = join(directory, 'password');
  const unitPath = join(configHome, 'systemd/user', service);
  const caddyConfigPath = join(directory, 'caddy.json');
  const owned = await optional(join(directory, '.managed'));
  if (owned && owned.trim() !== marker) throw new Error('The phone directory belongs to another application.');
  if (action === 'install') {
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST' || !owned) throw error; }
    await chmod(directory, 0o700); await atomic(join(directory, '.managed'), marker + '\n');
  } else if (!owned) throw new Error('Run pnpm phone:install first.');
  return withFileLock(join(directory, 'operation.lock'), async () => {
  const saved = await optional(settingsPath);
  if (action !== 'install') {
    if (!saved) throw new Error('Run pnpm phone:install first.');
    const installed = JSON.parse(saved);
    const before = await status(), current = route(before, installed);
    if (action === 'status') {
      console.log(JSON.stringify({ gateway: await active(), publicUrl: installed.publicUrl, published: current.published, passwordFile: passwordPath }, null, 2)); return;
    }
    if (action === 'disable') {
      if (current.occupied) await funnel(['off']);
      const after = await status();
      if (route(after, installed).published || !isDeepStrictEqual(unrelated(before, current.authority), unrelated(after, current.authority))) throw new Error('The Tailscale configuration needs inspection.');
      console.log('Phone public access is disabled. The private route is unchanged.'); return;
    }
    await probe(installed, (await readFile(passwordPath, 'utf8')).trim());
    if (!current.published) await funnel(['--bg', `http://127.0.0.1:${installed.listenPort}`]);
    const after = await status();
    if (!route(after, installed).published || !isDeepStrictEqual(unrelated(before, current.authority), unrelated(after, current.authority))) throw new Error('The Tailscale configuration needs inspection.');
    console.log(`Phone address: ${installed.publicUrl}\nUsername: emachine\nPassword file: ${passwordPath}\nVerify public access before installing the Home Screen app.`); return;
  }
  const original = await readFile(configPath, 'utf8'), config = JSON.parse(original);
  const upstreamOrigin = `http://127.0.0.1:${config.port}`;
  if (!config.gatewaySecret || !config.allowedOrigins?.includes(upstreamOrigin)) throw new Error('The native server must already have a gateway secret and its loopback origin configured. Phone setup never restarts it.');
  const node = JSON.parse((await exec('tailscale', ['status', '--json'])).stdout);
  if (node.BackendState !== 'Running' || !node.Self?.DNSName) throw new Error('Start Tailscale on the machine server first.');
  const publicUrl = publicAddress(`https://${node.Self.DNSName.replace(/\.$/, '')}:${publicPort}/`).href;
  const inventory = await fetch(`http://127.0.0.1:${config.port}/api/v1/state`, { signal: AbortSignal.timeout(10000) });
  if (!inventory.ok) throw new Error('The local machine server is unavailable.');
  const { machine } = await inventory.json();
  const previous = saved ? JSON.parse(saved) : undefined;
  if (previous && (previous.publicUrl !== publicUrl || previous.machine.id !== machine.id)) throw new Error('The installed phone gateway belongs to another machine or address.');
  route(await status(), { publicUrl, listenPort });
  const previousUnit = await optional(unitPath);
  if (previousUnit && !previousUnit.includes(marker)) throw new Error('The phone service file belongs to another application.');
    const caddy = await ensureCaddy();
    let password = (await optional(passwordPath))?.trim();
    if (previous && !password) throw new Error('The saved phone password is missing. Restore the password file before reinstalling.');
    if (!password) { password = randomBytes(32).toString('base64url'); await atomic(passwordPath, password + '\n'); }
    if (!/^[A-Za-z0-9_-]{43}$/.test(password)) throw new Error('The saved phone password is invalid.');
    const passwordHash = previous?.passwordHash || execFileSync(caddy, ['hash-password', '--algorithm', 'bcrypt'], { input: password + '\n', encoding: 'utf8' }).trim();
    const installed = { publicUrl, listenPort, upstreamPort: config.port, upstreamOrigin, machine: { id: machine.id, name: machine.name }, passwordHash, gatewaySecret: config.gatewaySecret, sessionSocket: join(directory, 'session.sock') };
    const caddyConfig = JSON.stringify(gatewayConfig(installed), null, 2) + '\n';
    const previousCaddy = await optional(caddyConfigPath);
    const runtime = fileURLToPath(new URL('./phone-runtime.mjs', import.meta.url));
    const runtimeHash = createHash('sha256');
    for (const file of ['phone-runtime.mjs', 'phone-session.mjs', 'phone-lock.mjs', 'caddy.mjs']) {
      const bytes = await readFile(new URL(file, import.meta.url));
      runtimeHash.update(`${file}\0${bytes.length}\0`).update(bytes);
    }
    const unit = `${marker}
# runtime-sha256=${runtimeHash.digest('hex')}
[Unit]
Description=emachine authenticated phone gateway
After=emachine.service network-online.target
Wants=emachine.service

[Service]
Type=simple
ExecStart=${unitQuote(process.execPath)} ${unitQuote(runtime)} ${unitQuote(settingsPath)} ${unitQuote(caddyConfigPath)}
Environment=${unitQuote('XDG_DATA_HOME=' + join(directory, 'data'))}
Environment=${unitQuote('XDG_CONFIG_HOME=' + directory)}
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${unitQuote(directory)}
Restart=on-failure
RestartSec=2
LimitNOFILE=2048

[Install]
WantedBy=default.target
`;
    const candidate = join(directory, service);
    await atomic(candidate, unit);
    await exec('systemd-analyze', ['--user', 'verify', candidate]);
    if (await readFile(configPath, 'utf8') !== original) throw new Error('The machine configuration changed during installation.');
    const wasActive = await active() === 'active';
    const enabled = (await exec('systemctl', ['--user', 'is-enabled', service]).catch(error => ({ stdout: error.stdout || 'disabled' }))).stdout.trim();
    if (!['enabled', 'disabled', 'not-found', ''].includes(enabled)) throw new Error('The phone service has an unsupported enablement state.');
    const files = [
      { path: caddyConfigPath, before: previousCaddy, text: caddyConfig, mode: 0o600 },
      { path: settingsPath, before: saved, text: JSON.stringify(installed, null, 2) + '\n', mode: 0o600 },
      { path: unitPath, before: previousUnit, text: unit, mode: 0o644 },
    ];
    for (const file of files) if (file.before !== undefined) file.previousMode = (await stat(file.path)).mode & 0o777;
    const written = [];
    try {
      await mkdir(dirname(unitPath), { recursive: true });
      for (const file of files) {
        if (await optional(file.path) !== file.before) throw new Error('A gateway file changed during installation.');
        await atomic(file.path, file.text, file.mode); written.push(file);
      }
      await exec('systemctl', ['--user', 'daemon-reload']);
      await exec('systemctl', ['--user', 'enable', service]);
      if (previousUnit !== unit || previousCaddy !== caddyConfig || await active() !== 'active') await exec('systemctl', ['--user', 'restart', service]);
      let failure;
      for (let attempt = 0; attempt < 20; attempt++) {
        try { await probe(installed, password); failure = undefined; break; }
        catch (error) { failure = error; await new Promise(resolve => setTimeout(resolve, 300)); }
      }
      if (failure) throw failure;
    } catch (error) {
      const failures = [];
      const recover = async action => { try { await action(); } catch (cause) { failures.push(cause); } };
      await recover(() => exec('systemctl', ['--user', 'stop', service]));
      if (enabled !== 'enabled') await recover(() => exec('systemctl', ['--user', 'disable', service]));
      for (const file of written.reverse()) await recover(async () => {
        if (await optional(file.path) !== file.text) throw new Error('A gateway file changed outside this installation; recovery preserved it.');
        if (file.before === undefined) await rm(file.path);
        else await atomic(file.path, file.before, file.previousMode);
      });
      await recover(() => exec('systemctl', ['--user', 'daemon-reload']));
      if (enabled === 'enabled') await recover(() => exec('systemctl', ['--user', 'enable', service]));
      if (wasActive && !failures.length) await recover(() => exec('systemctl', ['--user', 'start', service]));
      if (failures.length) throw new AggregateError([error, ...failures], `${error.message}\nGateway recovery needs inspection: ${failures.map(cause => cause.message).join('; ')}`);
      throw error;
    }
    console.log(`The authenticated gateway is ready on loopback. No public route was enabled.\nPhone address after approval: ${publicUrl}\nUsername: emachine\nPassword file: ${passwordPath}\nRun pnpm phone:enable to request Funnel approval and publish this route.`);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
