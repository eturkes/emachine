import { readFile, lstat, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { startSessionServer } from './phone-session.mjs';
import { ensureCaddy } from './caddy.mjs';
import { withFileLock } from './phone-lock.mjs';

async function removeStaleSocket(path) {
  try { if (!(await lstat(path)).isSocket()) throw new Error('The session socket path belongs to another file.'); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const occupied = await new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', error => ['ECONNREFUSED', 'ENOENT'].includes(error.code) ? resolve(false) : reject(error));
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('The session socket owner did not respond.')); });
  });
  if (occupied) throw new Error('Another process owns the session socket.');
  await rm(path, { force: true });
}

export async function runPhone(settingsPath, configPath) {
  const directory = dirname(settingsPath);
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  if (settings.sessionSocket !== join(directory, 'session.sock')) throw new Error('The session socket must stay in the private phone directory.');
  const caddy = await ensureCaddy();
  await withFileLock(join(directory, 'runtime.lock'), async () => {
    await removeStaleSocket(settings.sessionSocket);
    const session = await startSessionServer(settings);
    let child, timer, requested = false;
    const stop = () => {
      requested = true;
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        timer ??= setTimeout(() => child.kill('SIGKILL'), 3000);
      }
    };
    const signals = ['SIGINT', 'SIGTERM'];
    for (const signal of signals) process.once(signal, stop);
    try {
      child = spawn(caddy, ['run', '--config', configPath], { stdio: ['ignore', 'inherit', 'inherit'] });
      await new Promise((resolve, reject) => {
        child.once('error', reject);
        session.server.once('error', error => { stop(); reject(error); });
        child.once('exit', code => requested ? resolve() : reject(new Error(`The phone proxy exited unexpectedly (${code}).`)));
      });
    } finally {
      stop();
      if (child?.pid && child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once('exit', resolve));
      clearTimeout(timer);
      for (const signal of signals) process.removeListener(signal, stop);
      await session.close();
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runPhone(process.argv[2], process.argv[3]).catch(() => { console.error('The phone gateway stopped. Check its private configuration and service state.'); process.exitCode = 1; });
}
