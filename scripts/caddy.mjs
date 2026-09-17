import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile, rename, rm, chmod, lstat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const exec = promisify(execFile);
export const version = '2.11.4';
const archiveHash = '527fbf917c39189a1e3b31d34fa955601680b2d5c8055d2a87b8b9588dec7bb9';
const root = fileURLToPath(new URL('../.tools/', import.meta.url));
const directory = join(root, `caddy-${version}`);
export const caddyPath = join(directory, 'caddy');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export async function ensureCaddy() {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('The phone gateway requires Linux x86-64.');
  try {
    const [bytes, expected] = await Promise.all([readFile(caddyPath), readFile(join(directory, 'SHA256'), 'utf8')]);
    if (digest(bytes) !== expected.trim()) throw new Error('The local Caddy checksum changed. Remove its .tools directory and retry.');
    return caddyPath;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(root, { recursive: true });
  const staging = join(root, `.caddy-${randomUUID()}`);
  await mkdir(staging, { mode: 0o700 });
  try {
    const response = await fetch(`https://github.com/caddyserver/caddy/releases/download/v${version}/caddy_${version}_linux_amd64.tar.gz`, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Caddy download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (digest(bytes) !== archiveHash) throw new Error('Caddy archive checksum mismatch.');
    const archive = join(staging, 'caddy.tar.gz');
    await writeFile(archive, bytes);
    await exec('tar', ['-xzf', archive, '-C', staging, 'caddy']);
    if (!(await lstat(join(staging, 'caddy'))).isFile()) throw new Error('Caddy must be a regular executable.');
    await chmod(join(staging, 'caddy'), 0o755);
    await writeFile(join(staging, 'SHA256'), digest(await readFile(join(staging, 'caddy'))) + '\n');
    await rm(archive);
    await rename(staging, directory);
    return caddyPath;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(await ensureCaddy());
