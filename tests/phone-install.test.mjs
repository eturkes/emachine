import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { route, unrelated } from '../scripts/phone-access.mjs';
import { root } from './network-helper.mjs';

const exec = promisify(execFile);
const installed = { publicUrl: 'https://phone.example:8443/', listenPort: 4738 };
const own = { TCP: { 8443: { HTTPS: true } }, Web: { 'phone.example:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4738' } } } }, AllowFunnel: { 'phone.example:8443': true } };

test('Funnel ownership includes foreground and incomplete authority declarations', () => {
  assert.equal(route(own, installed).published, true);
  assert.equal(route({}, installed).published, false);
  for (const declaration of [own, { TCP: own.TCP }, { Web: own.Web }, { AllowFunnel: own.AllowFunnel }]) {
    assert.throws(() => route({ Foreground: { session: declaration } }, installed), /another|foreground|owned/i);
  }
  assert.throws(() => route({ AllowFunnel: own.AllowFunnel }, installed), /another|owned/i);
  assert.throws(() => route({ ...own, Web: { 'phone.example:8443': { Handlers: { '/': { ...own.Web['phone.example:8443'].Handlers['/'], Path: '/foreign' } } } } }, installed));
  const other = { TCP: { 4743: { HTTPS: true } }, Foreground: { session: { TCP: { 10000: { HTTPS: true } } } }, Services: { 'svc:other': { TCP: { 8443: { HTTPS: true } } } } };
  const all = { ...other, ...own, TCP: { ...other.TCP, ...own.TCP } };
  assert.equal(route(all, installed).published, true);
  assert.deepEqual(unrelated(all, 'phone.example:8443'), other);
});

async function installation(t, { saved = true, password = true, staleLock = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'emachine-install-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, 'phone'), configHome = join(home, 'config'), bin = join(home, 'bin');
  await mkdir(directory); await mkdir(bin); await mkdir(join(configHome, 'systemd/user'), { recursive: true });
  await writeFile(join(directory, '.managed'), '# emachine phone gateway managed\n');
  const machine = { id: 'fixture', name: 'Fixture' };
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.url === '/api/v1/jobs' ? { jobs: [{ status: 'running' }] } : { machine })); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const port = server.address().port;
  const config = { port, gatewaySecret: randomBytes(32).toString('hex'), allowedOrigins: [`http://127.0.0.1:${port}`] };
  const configPath = join(home, 'config.json'); await writeFile(configPath, JSON.stringify(config));
  const unitPath = join(configHome, 'systemd/user/emachine-phone.service');
  const paths = [join(directory, 'caddy.json'), join(directory, 'settings.json'), unitPath];
  if (saved) {
    await writeFile(paths[0], '{"previous":"gateway"}');
    await writeFile(paths[1], JSON.stringify({ ...installed, publicUrl: 'https://phone.example:8443/', machine, passwordHash: '$2a$14$' + '.'.repeat(53) }));
    await writeFile(paths[2], '# emachine phone gateway managed\n[Service]\nExecStart=/bin/true\n');
    await chmod(paths[0], 0o600); await chmod(paths[1], 0o600); await chmod(paths[2], 0o640);
  }
  if (password) await writeFile(join(directory, 'password'), randomBytes(32).toString('base64url') + '\n');
  if (staleLock) await mkdir(join(directory, 'install.lock'));
  const fake = `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
const name = path.basename(process.argv[1]), args = process.argv.slice(2);
fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify([name, ...args]) + '\\n');
if (name === 'tailscale') { console.log(JSON.stringify(args[0] === 'status' ? { BackendState: 'Running', Self: { DNSName: 'phone.example.' } } : {})); }
if (name === 'systemctl') {
 if (args.includes('is-active')) { console.log(${saved ? "'active'" : "'inactive'"}); }
 if (args.includes('is-enabled')) { console.log(${saved ? "'enabled'" : "'disabled'"}); }
 if (args.includes('restart') && args.includes('emachine-phone.service') && fs.existsSync(process.env.FAIL_ONCE)) { fs.unlinkSync(process.env.FAIL_ONCE); console.error('MOCK_GATEWAY_FAILURE'); process.exit(1); }
}
`;
  for (const name of ['tailscale', 'systemctl', 'systemd-analyze']) await writeFile(join(bin, name), fake, { mode: 0o755 });
  const log = join(home, 'commands.log'), failure = join(home, 'fail-once'); await writeFile(failure, '1');
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, EMACHINE_CONFIG: configPath, COMMAND_LOG: log, FAIL_ONCE: failure, PATH: bin + ':' + process.env.PATH };
  return { home, directory, paths, configPath, env,
    async run() { return exec(process.execPath, [join(root, 'scripts/phone-access.mjs'), 'install'], { env, timeout: 20000 }).then(result => ({ ...result, code: 0 }), error => ({ stdout: error.stdout, stderr: error.stderr, code: error.code })); },
    async commands() { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); },
  };
}

test('failed reinstall restores gateway bytes and modes without changing or restarting native', async t => {
  const f = await installation(t, { staleLock: true });
  const before = await Promise.all(f.paths.map(path => readFile(path, 'utf8')));
  const modes = await Promise.all(f.paths.map(async path => (await stat(path)).mode));
  const native = await readFile(f.configPath, 'utf8');
  const result = await f.run();
  assert.match(result.stderr, /MOCK_GATEWAY_FAILURE/);
  assert.deepEqual(await Promise.all(f.paths.map(path => readFile(path, 'utf8'))), before);
  assert.deepEqual(await Promise.all(f.paths.map(async path => (await stat(path)).mode)), modes);
  assert.equal(await readFile(f.configPath, 'utf8'), native);
  const commands = await f.commands();
  assert.ok(commands.some(args => args.includes('stop') && args.includes('emachine-phone.service')));
  assert.ok(commands.some(args => args.includes('start') && args.includes('emachine-phone.service')));
  assert.ok(!commands.some(args => args.includes('emachine.service')));
});

test('failed first installation removes candidate files and disables only its gateway', async t => {
  const f = await installation(t, { saved: false });
  const result = await f.run();
  assert.match(result.stderr, /MOCK_GATEWAY_FAILURE/);
  for (const path of f.paths) await assert.rejects(readFile(path), { code: 'ENOENT' });
  assert.ok((await f.commands()).some(args => args.includes('disable') && args.includes('emachine-phone.service')));
});

test('missing saved password fails without creating a mismatched replacement', async t => {
  const f = await installation(t, { password: false });
  const before = await readFile(f.paths[1], 'utf8');
  const result = await f.run();
  assert.match(result.stderr, /password.*missing|restore.*password/i);
  await assert.rejects(readFile(join(f.directory, 'password')), { code: 'ENOENT' });
  assert.equal(await readFile(f.paths[1], 'utf8'), before);
  assert.ok(!(await f.commands()).some(args => args.includes('restart')));
});

test('operation lock releases after its owner is killed', { timeout: 10000 }, async t => {
  const { withFileLock } = await import('../scripts/phone-lock.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'emachine-lock-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lock = join(directory, 'lock');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { withFileLock } from ${JSON.stringify(new URL('../scripts/phone-lock.mjs', import.meta.url).href)}; await withFileLock(${JSON.stringify(lock)}, async () => { console.log('locked'); await new Promise(() => {}); });`], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await once(child.stdout, 'data');
  await assert.rejects(withFileLock(lock, async () => {}), /another|locked/i);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  let result;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { result = await withFileLock(lock, async () => 'released'); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  assert.equal(result, 'released');
});
