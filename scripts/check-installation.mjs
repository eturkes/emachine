import assert from 'node:assert/strict';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
const config = JSON.parse(await readFile(process.env.EMACHINE_CONFIG || join(configHome, 'emachine/config.json'), 'utf8'));
assert.equal((await exec('systemctl', ['--user', 'is-active', 'emachine.service'])).stdout.trim(), 'active');
assert.equal((await exec('systemctl', ['--user', 'is-enabled', 'emachine.service'])).stdout.trim(), 'enabled');
await exec('systemd-analyze', ['--user', 'verify', join(configHome, 'systemd/user/emachine.service')]);
const projectRoot = await realpath(config.projectRoot);
for (const path of [config.dataRoot, config.stateRoot, config.runtimeRoot]) {
  const absolute = await realpath(path);
  assert.ok(absolute !== projectRoot && !absolute.startsWith(projectRoot + sep) && !projectRoot.startsWith(absolute + sep));
}
for (const base of [`http://127.0.0.1:${config.port}/`, config.directUrl]) {
  const response = await fetch(new URL('api/v1/health', base), { headers: { Origin: 'emachine://app' }, signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), 'emachine://app');
  assert.deepEqual(await response.json(), { ok: true, protocol: 1 });
}
const seed = JSON.parse(await readFile(join(root, 'web/dist/bootstrap.json'), 'utf8'));
assert.ok(Array.isArray(seed.servers));
for (const server of seed.servers) assert.ok(Object.keys(server).every(key => ['id', 'name', 'direct', 'gateway'].includes(key)));
async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await scan(path);
    else if (entry.isFile() && config.gatewaySecret) assert.ok(!(await readFile(path)).includes(Buffer.from(config.gatewaySecret)), 'A private credential entered the client build.');
  }
}
await scan(join(root, 'web/dist'));

const terminalOption = process.argv.indexOf('--terminal');
if (terminalOption >= 0) {
  const name = process.argv[terminalOption + 1];
  assert.ok(name && !name.startsWith('--'), 'Use --terminal PROJECT for an existing zmx session.');
  const env = { ...process.env };
  delete env.ZMX_SESSION; delete env.ZMX_SESSION_PREFIX;
  async function session() {
    const { stdout } = await exec('zmx', ['list'], { env, timeout: 5000 });
    const match = [...stdout.matchAll(/^\s*name=(.*?)\tpid=(\d+)\tclients=(\d+)/gm)].find(m => m[1] === name);
    return match && { pid: Number(match[2]), clients: Number(match[3]) };
  }
  const before = await session();
  assert.ok(before, `The manual zmx session ${name} must already exist.`);
  const response = await fetch(`http://127.0.0.1:${config.port}/api/v1/state`, {
    headers: { Origin: 'emachine://app' }, signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200);
  const project = (await response.json()).projects.find(p => p.name === name);
  assert.ok(project, `The project ${name} must exist.`);
  const ws = new WebSocket(`ws://127.0.0.1:${config.port}/api/v1/terminal/${project.id}`, {
    headers: { Origin: 'emachine://app' }, handshakeTimeout: 5000,
  });
  const closed = new Promise(resolve => ws.once('close', resolve));
  try {
    const state = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Terminal state timed out.')), 15000);
      const finish = (error, value) => { clearTimeout(timer); error ? reject(error) : resolve(value); };
      ws.on('error', error => finish(error));
      ws.once('close', () => finish(new Error('Terminal closed before verification.')));
      ws.on('message', (data, binary) => {
        if (binary) return;
        try {
          const packet = JSON.parse(data.toString());
          if (packet.type === 'state') finish(null, packet);
          if (packet.type === 'error') finish(new Error(packet.message));
        } catch (error) { finish(error); }
      });
    });
    assert.equal(state.session, name);
    const deadline = Date.now() + 15000;
    let attached;
    do { attached = await session(); if (attached?.clients >= before.clients + 1) break; await sleep(70); }
    while (Date.now() < deadline);
    assert.equal(attached?.pid, before.pid, 'The original zmx daemon must remain alive.');
    assert.ok(attached.clients >= before.clients + 1, 'The connection must attach to the manual session.');
  } finally {
    ws.close();
    const timer = setTimeout(() => ws.terminate(), 1000);
    try { await closed; } finally { clearTimeout(timer); }
  }
  assert.equal((await session())?.pid, before.pid);
  console.log(`Existing terminal reused: ${name}, zmx PID ${before.pid}. No terminal input was sent.`);
}
console.log('Installed service passed: enabled and active, valid unit, isolated storage, loopback and Tailscale HTTPS, exact desktop CORS, credential-free client.');
