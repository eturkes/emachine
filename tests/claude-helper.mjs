import { mkdir, readFile, readlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Use real process identities, but never start Claude or access the user's sessions.
export async function claudeSession(f, status, options = {}) {
  const pid = options.pid ?? process.pid;
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const machine = (await readFile('/etc/machine-id', 'utf8')).trim();
  const namespace = await readlink('/proc/self/ns/pid');
  const root = join(f.home, '.claude/sessions');
  await mkdir(root, { recursive: true });
  const record = {
    pid, sessionId: `fixture-${pid}`, cwd: join(f.config.projectRoot, 'alpha'),
    startedAt: Date.now(), procStart, pidDomain: `linux:${machine}:${namespace}`,
    kind: 'interactive', status, ...options,
  };
  const path = join(root, `${pid}.json`);
  await writeFile(path, JSON.stringify(record));
  return { path, record };
}
