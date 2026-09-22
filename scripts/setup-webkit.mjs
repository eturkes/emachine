import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit } from '@playwright/test';

const exec = promisify(execFile), root = fileURLToPath(new URL('../', import.meta.url));
const tools = join(root, '.tools'), browsers = join(tools, 'playwright');
const libraries = [
  ['main/i/icu/libicu74_74.2-1ubuntu3_amd64.deb', 'd29c97a21a3e3254731cfac186e4d4e611e5e67d2c9a0430f6acfbd9acaefa2e'],
  ['main/libm/libmanette/libmanette-0.2-0_0.2.7-1build2_amd64.deb', '8fbb67e94abf563c01398ad7458df1a6824f19a0b4337f67d61c0889771805db'],
  ['universe/f/flite/libflite1_2.2-6build3_amd64.deb', '367f1d0da5cd38759a0515eafc27aa133b2d7bf99308cac34831df0212e96b75'],
];
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('The phone browser gate requires Linux x86-64.');
if (!existsSync(join(browsers, basename(dirname(webkit.executablePath())), 'pw_run.sh'))) {
  await exec('pnpm', ['exec', 'playwright', 'install', 'webkit'], { cwd: root, env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers }, maxBuffer: 4 * 1024 * 1024 });
}
const destination = join(tools, 'webkit-deps-noble-v1'), manifest = JSON.stringify(libraries) + '\n';
if (existsSync(destination)) {
  if (await readFile(join(destination, 'manifest.json'), 'utf8') !== manifest) throw new Error('The private WebKit dependency cache needs inspection.');
} else {
  await mkdir(tools, { recursive: true });
  const staging = await mkdtemp(join(tools, '.webkit-deps-'));
  try {
    for (const [path, expected] of libraries) {
      const response = await fetch('https://archive.ubuntu.com/ubuntu/pool/' + path, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error(`WebKit library download failed: HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('WebKit library checksum mismatch.');
      const archive = join(staging, 'package.deb'); await writeFile(archive, bytes);
      const names = (await exec('ar', ['t', archive])).stdout.trim().split('\n').filter(name => /^data\.tar\.(xz|zst|gz)$/.test(name));
      if (names.length !== 1) throw new Error('The verified library archive has no unique data payload.');
      const data = join(staging, names[0]);
      await writeFile(data, (await exec('ar', ['p', archive, names[0]], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 })).stdout);
      await exec('tar', ['-xf', data, '-C', staging]);
      await rm(data); await rm(archive);
    }
    await writeFile(join(staging, 'manifest.json'), manifest);
    await rename(staging, destination);
  } finally { await rm(staging, { recursive: true, force: true }); }
}
console.log('Private WebKit browser and pinned compatibility libraries are ready.');
