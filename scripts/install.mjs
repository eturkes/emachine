import { readFile, writeFile, mkdir, rename, chmod, access, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, userInfo, hostname } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
if (process.platform !== 'linux') throw new Error('The machine server requires Linux.');
const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  console.log('Usage: node scripts/install.mjs --direct HTTPS_URL [--public HTTPS_CLIENT_ROOT | --no-gateway]');
  process.exit(0);
}
const option = name => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
function address(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('Use HTTPS or localhost HTTP.');
  if (url.username || url.password || url.search || url.hash) throw new Error('Addresses must not contain credentials, queries or fragments.');
  url.pathname = url.pathname.replace(/\/*$/, '/');
  return url;
}
const home = await realpath(homedir());
const root = fileURLToPath(new URL('../', import.meta.url));
const binary = join(root, 'core/_build/native/release/build/cmd/main/main.exe');
await access(binary); await access(join(root, 'web/dist/index.html'));
const configHome = process.env.XDG_CONFIG_HOME || join(home, '.config');
const configPath = process.env.EMACHINE_CONFIG || join(configHome, 'emachine/config.json');
let previous = {};
try { previous = JSON.parse(await readFile(configPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const direct = address(option('--direct') || previous.directUrl || 'http://127.0.0.1:4737/');
const publicRoot = option('--public') ? address(option('--public')) : undefined;
let owner;
try {
  const status = JSON.parse((await exec('tailscale', ['status', '--json'])).stdout);
  owner = status.User?.[status.Self?.UserID]?.LoginName;
} catch { /* Local-only installs do not require Tailscale. */ }
const config = {
  port: 4737, projectRoot: join(home, 'Projects'),
  dataRoot: join(process.env.XDG_DATA_HOME || join(home, '.local/share'), 'emachine'),
  stateRoot: join(process.env.XDG_STATE_HOME || join(home, '.local/state'), 'emachine'),
  runtimeRoot: join(process.env.XDG_RUNTIME_DIR || join(home, '.local/state'), 'emachine-runtime'),
  webRoot: join(root, 'web/dist'), machineName: hostname(),
  allowedUsers: owner ? [owner] : [], allowedOrigins: [],
  shell: userInfo().shell || '/bin/bash', snapshotBackend: 'auto',
  ...previous, directUrl: direct.href,
};
if (argv.includes('--no-gateway')) config.gatewayUrl = '';
config.allowedOrigins = [...new Set([
  ...(config.allowedOrigins || []), `http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`,
  'emachine://app', direct.origin, ...(publicRoot ? [publicRoot.origin] : []),
])];
if (publicRoot && !config.gatewaySecret) config.gatewaySecret = randomBytes(32).toString('hex');
async function atomic(path, text, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.pending-' + randomUUID();
  await writeFile(temporary, text, { mode }); await rename(temporary, path); await chmod(path, mode);
}
await atomic(configPath, JSON.stringify(config, null, 2) + '\n');
const state = JSON.parse((await exec(binary, ['projects'], { env: { ...process.env, EMACHINE_CONFIG: configPath } })).stdout);
if (publicRoot) {
  config.gatewayUrl = new URL(`m/${state.machine.id}/`, publicRoot).href;
  await atomic(configPath, JSON.stringify(config, null, 2) + '\n');
}
const launcher = join(home, '.local/bin/emachine');
const unitPath = join(configHome, 'systemd/user/emachine.service');
async function owned(path, text, mode) {
  try { if (!(await readFile(path, 'utf8')).includes('# emachine managed')) throw new Error(`Refusing to replace an unrelated file: ${path}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await atomic(path, text, mode);
}
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
await owned(launcher, `#!/bin/sh\n# emachine managed launcher\nexec ${shellQuote(binary)} "$@"\n`, 0o755);
const unitQuote = value => '"' + value.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
await owned(unitPath, `# emachine managed user service
[Unit]
Description=emachine personal project server
After=network-online.target

[Service]
Type=simple
ExecStart=${unitQuote(launcher)} serve
Environment=${unitQuote('EMACHINE_CONFIG=' + configPath)}
Environment=${unitQuote('PATH=' + join(home, '.local/bin') + ':' + join(home, '.moon/bin') + ':/usr/local/bin:/usr/bin:/bin')}
UMask=0077
# zmx daemons must survive machine-server restarts. The core cancels its supervised jobs on shutdown.
KillMode=process
TimeoutStopSec=15
Restart=on-failure
RestartSec=2
LimitNOFILE=8192

[Install]
WantedBy=default.target
`, 0o644);
await exec('systemd-analyze', ['--user', 'verify', unitPath]);
await exec('systemctl', ['--user', 'daemon-reload']);
await exec('systemctl', ['--user', 'enable', 'emachine.service']);
await exec('systemctl', ['--user', 'restart', 'emachine.service']);
console.log(JSON.stringify({ config: configPath, launcher, unit: unitPath, machine: state.machine.id, direct: config.directUrl, gateway: config.gatewayUrl || null }, null, 2));
