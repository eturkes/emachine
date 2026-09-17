import { spawn } from 'node:child_process';

export async function withFileLock(path, run) {
  // The child holds flock only while this process keeps its stdin open, including after a parent crash.
  const child = spawn('flock', ['--exclusive', '--nonblock', path, process.execPath, '-e', "process.stdout.write('locked\\n'); process.stdin.resume();"], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', () => resolve(-1)); });
  child.stderr.resume(); child.stdin.on('error', () => {});
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => reject(new Error('Another phone operation holds the lock.')));
      child.stdout.once('data', bytes => bytes.toString() === 'locked\n' ? resolve() : reject(new Error('The phone operation lock failed.')));
    });
    return await run();
  } finally { child.stdin.end(); await exited; }
}
