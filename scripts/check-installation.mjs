import assert from 'node:assert/strict';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
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
console.log('Installed service passed: enabled and active, valid unit, isolated storage, loopback and Tailscale HTTPS, exact desktop CORS, credential-free client.');
