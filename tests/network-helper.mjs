import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const exec = promisify(execFile);
export const root = fileURLToPath(new URL('../', import.meta.url));
export const binary = resolve(root, 'core/_build/native/release/build/cmd/main/main.exe');
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const result = await fn(); if (result) return result; } catch (error) { last = error; }
    await sleep(70);
  }
  throw new Error(`Condition timed out${last ? `: ${last.message}` : ''}`);
}
export async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
export async function fixture(options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'emachine-test-'));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const config = {
    port, projectRoot: join(home, 'Projects'), dataRoot: join(home, 'data'),
    stateRoot: join(home, 'state'), runtimeRoot: join(home, 'runtime'),
    webRoot: resolve(root, 'web/dist'), machineName: options.name ?? 'Test workstation',
    allowedUsers: ['fixture-owner'], allowedOrigins: [origin, 'emachine://app', ...(options.origins ?? [])],
    directUrl: `${origin}/`, gatewayUrl: '', gatewaySecret: randomUUID(),
    snapshotBackend: 'copy', shell: '/bin/bash',
  };
  await mkdir(join(config.projectRoot, 'alpha'), { recursive: true });
  await mkdir(join(config.projectRoot, 'beta'), { recursive: true });
  await writeFile(join(home, '.bash_profile'), 'PS1="fixture> "\nexport PS1\n');
  const configPath = join(home, 'config.json');
  await writeFile(configPath, JSON.stringify(config));
  const env = {
    ...process.env, HOME: home, HISTFILE: join(home, 'history'), EMACHINE_CONFIG: configPath,
    XDG_RUNTIME_DIR: join(home, 'xdg-runtime'), XDG_STATE_HOME: join(home, 'xdg-state'),
  };
  delete env.ZMX_DIR; delete env.ZMX_SESSION; delete env.ZMX_SESSION_PREFIX;
  if (options.zmxDir) env.ZMX_DIR = join(home, 'custom-zmx');
  await mkdir(env.XDG_RUNTIME_DIR, { mode: 0o700 });
  let processHandle;
  let logs = '';
  const f = {
    home, port, origin, config, env,
    async cli(...args) { return (await exec(binary, args, { env, timeout: 90000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim(); },
    async request(path, options = {}) {
      return fetch(`${origin}/${path}`, { ...options, headers: { Origin: origin, ...options.headers }, signal: AbortSignal.timeout(15000) });
    },
    async state() { const res = await f.request('api/v1/state'); if (!res.ok) throw new Error(await res.text()); return res.json(); },
    async start() {
      if (processHandle) throw new Error('Fixture server is already running');
      processHandle = spawn(binary, ['serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      processHandle.stdout.on('data', data => { logs = (logs + data).slice(-20000); });
      processHandle.stderr.on('data', data => { logs = (logs + data).slice(-20000); });
      await until(async () => {
        if (processHandle.exitCode !== null) throw new Error(`Server exited: ${logs}`);
        try { return (await f.request('api/v1/health')).ok; } catch { return false; }
      });
    },
    async stop(signal = 'SIGTERM') {
      if (!processHandle) return;
      const child = processHandle;
      if (child.exitCode === null && child.signalCode === null) {
        const ended = new Promise(resolve => child.once('exit', resolve));
        child.kill(signal);
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
        await ended; clearTimeout(timer);
      }
      processHandle = undefined;
    },
    async close() {
      await f.stop();
      // Both namespaces belong to this fixture; include pre-fix servers and renamed projects.
      for (const directory of [env.ZMX_DIR ?? join(env.XDG_RUNTIME_DIR, 'zmx'), join(config.runtimeRoot, 'zmx')]) {
        const cleanupEnv = { ...env, ZMX_DIR: directory };
        delete cleanupEnv.ZMX_SESSION; delete cleanupEnv.ZMX_SESSION_PREFIX;
        const listed = await exec('zmx', ['list', '--short'], { env: cleanupEnv, timeout: 5000 }).catch(() => ({ stdout: '' }));
        for (const name of listed.stdout.split('\n').filter(Boolean)) {
          await exec('zmx', ['kill', name], { env: cleanupEnv, timeout: 5000 }).catch(() => {});
        }
      }
      await rm(home, { recursive: true, force: true });
    },
    get logs() { return logs; },
  };
  await f.start();
  return f;
}
export async function socket(f, path, headers = {}) {
  const ws = new WebSocket(`${f.origin.replace('http', 'ws')}/${path}`, { headers: { Origin: f.origin, ...headers }, maxPayload: 8 * 1024 * 1024 });
  const packets = [];
  let text = '';
  ws.on('message', (data, binary) => {
    if (binary) {
      text = (text + data.toString('utf8')).slice(-2 * 1024 * 1024);
      if (data.includes(Buffer.from('\x1b[c'))) ws.send(Buffer.from('\x1b[?1;2c'));
      if (data.includes(Buffer.from('\x1b[6n'))) ws.send(Buffer.from('\x1b[1;1R'));
    } else { try { packets.push(JSON.parse(data.toString())); } catch { packets.push(data.toString()); } }
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return {
    ws, packets, get text() { return text; },
    command(line) { ws.send(Buffer.from(line + '\r')); },
    control(data) { ws.send(JSON.stringify(data)); },
    async close() { if (ws.readyState === WebSocket.CLOSED) return; const done = new Promise(resolve => ws.once('close', resolve)); ws.close(); const timer = setTimeout(() => ws.terminate(), 1000); await done; clearTimeout(timer); },
  };
}
