import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { updateManifest, validateUpdateMetadata } from './update-metadata.mjs';

const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const exec = promisify(execFile);
const git = async (...args) => (await exec('git', args, { cwd: root })).stdout.trim();
async function run(command, args, cwd = root, extraEnv = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...extraEnv }, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} failed: ${signal || code}`)));
  });
}
async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

assert.equal(process.argv.length, 2, 'Usage: pnpm release:prepare (version comes from package.json).');
assert.equal(process.platform, 'linux', 'This release target requires Linux.');
assert.equal(process.arch, 'x64', 'This release target is Linux x86-64.');
assert.equal(await git('status', '--porcelain'), '', 'Commit the release source before building.');
const commit = await git('rev-parse', 'HEAD');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert.match(pkg.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Use a stable X.Y.Z release version.');
const tag = `v${pkg.version}`;
const destination = join(root, 'desktop/publish', tag);
try { await access(destination); throw new Error(`Release output already exists: ${destination}`); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

// Verify the exact committed source before creating a separate, configuration-free client build.
await run('pnpm', ['verify']);
await mkdir(join(root, '.work'), { recursive: true });
const stage = await mkdtemp(join(root, '.work/release-'));
try {
  const source = join(stage, 'source');
  const output = join(stage, 'output');
  const ready = join(stage, 'ready');
  await mkdir(source);
  await run('git', ['archive', '--format=tar', `--output=${join(stage, 'source.tar')}`, commit]);
  await run('tar', ['-xf', join(stage, 'source.tar'), '-C', source]);
  await run('pnpm', ['install', '--frozen-lockfile'], source);
  await run('pnpm', ['build:web'], source, { EMACHINE_CLIENT_SEED: 'empty' });
  assert.deepEqual(JSON.parse(await readFile(join(source, 'web/dist/bootstrap.json'), 'utf8')), { servers: [] });
  await run('pnpm', ['exec', 'electron-builder', '--linux', 'AppImage', '--x64', '--publish', 'never',
    `--config.directories.output=${output}`], source);
  const name = `emachine-${pkg.version}-x86_64.AppImage`;
  const artifact = join(output, name);
  await validateUpdateMetadata(output, pkg.version, name);
  await run(process.execPath, ['tests/desktop.mjs', '--unseeded'], root, { EMACHINE_APPIMAGE: artifact });
  assert.equal(await git('rev-parse', 'HEAD'), commit, 'The checkout changed during release preparation.');
  assert.equal(await git('status', '--porcelain'), '', 'The source changed during release preparation.');
  await mkdir(ready);
  const digest = await sha256(artifact);
  const metadata = { name: 'emachine', version: pkg.version, tag, commit, platform: 'linux', arch: 'x86_64',
    clientSeed: 'empty', electron: pkg.devDependencies.electron, node: process.version, packageManager: pkg.packageManager,
    asset: { name, bytes: (await stat(artifact)).size, sha256: digest } };
  await rename(artifact, join(ready, name));
  await rename(join(output, updateManifest), join(ready, updateManifest));
  await writeFile(join(ready, 'release.json'), JSON.stringify(metadata, null, 2) + '\n');
  await writeFile(join(ready, 'SHA256SUMS'), `${digest}  ${name}\n${await sha256(join(ready, 'release.json'))}  release.json\n${await sha256(join(ready, updateManifest))}  ${updateManifest}\n`);
  await mkdir(join(root, 'desktop/publish'), { recursive: true });
  await rename(ready, destination);
  console.log(`Prepared ${tag} from ${commit}\n${destination}\nNo remote changes were made. The installed AppImage is unchanged.`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
