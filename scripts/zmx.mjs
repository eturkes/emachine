import { createHash } from 'node:crypto';
import { constants, readFileSync } from 'node:fs';
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const tools = join(root, '.tools');
const patchPath = join(root, 'scripts/zmx-arrows.patch');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const upstreamVersion = '0.8.1';
export const clientVersion = '0.8.1-emachine-arrows.1';
const sourceCommit = '8bab1f0173b07e79835ea372d749af3dbf0d0842';
const sourceHash = '4929008140cd66ea29d5c7504c59198a82ec793e635b70bd0ece5aac2cad1767';
const zigVersion = '0.16.0';
const toolchains = {
  x64: { target: 'x86_64', sha256: '70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00' },
  arm64: { target: 'aarch64', sha256: 'ea4b09bfb22ec6f6c6ceac57ab63efb6b46e17ab08d21f69f3a48b38e1534f17' },
};
const patchBytes = readFileSync(patchPath);
const patchHash = digest(patchBytes);
const recipe = { clientVersion, sourceCommit, sourceHash, zigVersion, platform: process.platform,
  arch: process.arch, toolchainHash: toolchains[process.arch]?.sha256, patchHash, optimize: 'ReleaseSafe', abi: 'musl' };
const recipeHash = digest(JSON.stringify(recipe));
export const zmxDirectory = join(tools, 'zmx-' + clientVersion + '-' + process.arch + '-' + recipeHash.slice(0, 12));
export const zmxExecutable = join(zmxDirectory, 'zmx');

async function installed() {
  try {
    const manifest = JSON.parse(await readFile(join(zmxDirectory, 'manifest.json'), 'utf8'));
    if (manifest.recipeHash !== recipeHash) throw new Error('The private zmx build recipe changed.');
    if (!(await lstat(zmxExecutable)).isFile()) throw new Error('The private zmx client must be a regular file.');
    if (digest(await readFile(zmxExecutable)) !== manifest.binaryHash) throw new Error('The private zmx client checksum changed.');
    await access(zmxExecutable, constants.X_OK);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function archive(name, url, expected, maximum) {
  const directory = join(tools, 'downloads');
  await mkdir(directory, { recursive: true });
  const destination = join(directory, name);
  try {
    const bytes = await readFile(destination);
    if (bytes.length > maximum || digest(bytes) !== expected) throw new Error(name + ' cache checksum mismatch.');
    return destination;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(name + ' download failed: HTTP ' + response.status);
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maximum) throw new Error(name + ' exceeds its archive size limit.');
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  if (digest(bytes) !== expected) throw new Error(name + ' archive checksum mismatch.');
  const staging = await mkdtemp(join(directory, '.download-'));
  try {
    const temporary = join(staging, name);
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, destination);
  } finally { await rm(staging, { recursive: true, force: true }); }
  return destination;
}

export async function ensureZmx() {
  if (process.platform !== 'linux' || !toolchains[process.arch]) throw new Error('The emachine terminal host requires Linux x86-64 or ARM64.');
  if (await installed()) return zmxExecutable;
  await mkdir(tools, { recursive: true });
  const staging = await mkdtemp(join(tools, '.zmx-build-'));
  try {
    const toolchain = toolchains[process.arch];
    const sourceArchive = await archive('zmx-source-' + sourceCommit + '.tar.gz',
      'https://codeload.github.com/neurosnap/zmx/tar.gz/' + sourceCommit, sourceHash, 16 * 1024 * 1024);
    const zigName = 'zig-' + toolchain.target + '-linux-' + zigVersion + '.tar.xz';
    const zigArchive = await archive(zigName, 'https://ziglang.org/download/' + zigVersion + '/' + zigName,
      toolchain.sha256, 128 * 1024 * 1024);
    const source = join(staging, 'source'), compiler = join(staging, 'compiler');
    await mkdir(source); await mkdir(compiler);
    const stagedPatch = join(staging, 'arrows.patch');
    await writeFile(stagedPatch, patchBytes, { flag: 'wx', mode: 0o600 });
    await exec('tar', ['-xf', sourceArchive, '--strip-components=1', '-C', source], { timeout: 120000 });
    await exec('tar', ['-xf', zigArchive, '--strip-components=1', '-C', compiler], { timeout: 120000 });
    await exec('git', ['init', '--quiet'], { cwd: source, timeout: 30000 });
    await exec('git', ['apply', '--check', stagedPatch], { cwd: source, timeout: 30000 });
    await exec('git', ['apply', stagedPatch], { cwd: source, timeout: 30000 });
    const zig = join(compiler, 'zig');
    if ((await exec(zig, ['version'], { timeout: 15000 })).stdout.trim() !== zigVersion) throw new Error('The private Zig version differs from its pin.');
    const env = { ...process.env, ZIG_GLOBAL_CACHE_DIR: join(tools, 'zig-cache-' + zigVersion),
      ZIG_LOCAL_CACHE_DIR: join(staging, 'zig-cache') };
    const common = ['-Doptimize=ReleaseSafe', '-Dtarget=' + toolchain.target + '-linux-musl', '-Dversion=' + clientVersion];
    const options = { cwd: source, env, timeout: 900000, maxBuffer: 8 * 1024 * 1024 };
    console.log('Checking and building the pinned zmx client.');
    await exec(zig, ['build', 'test', ...common], options);
    const prefix = join(staging, 'install');
    await exec(zig, ['build', ...common, '--prefix', prefix], options);
    const built = join(prefix, 'bin/zmx');
    if (!(await lstat(built)).isFile()) throw new Error('The zmx build produced no regular executable.');
    const output = join(staging, 'result');
    await mkdir(output, { mode: 0o700 });
    await copyFile(built, join(output, 'zmx'));
    await chmod(join(output, 'zmx'), 0o755);
    await writeFile(join(output, 'manifest.json'), JSON.stringify({ recipe, recipeHash, binaryHash: digest(await readFile(built)) }, null, 2) + '\n');
    try { await rename(output, zmxDirectory); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code) || !await installed()) throw error;
    }
    if (!await installed()) throw new Error('The private zmx client was not installed.');
    return zmxExecutable;
  } finally { await rm(staging, { recursive: true, force: true }); }
}
