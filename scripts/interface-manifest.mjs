import { readdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MANIFEST, BRIDGE, assetPath, digest, validateManifest } from '../desktop/interface-manifest.cjs';

export async function buildInterfaceManifest(directory) {
  const files = [];
  async function scan(prefix = '') {
    for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (!prefix && ['assets', 'icons'].includes(entry.name)) {
        if (!entry.isDirectory()) throw new Error(`Interface asset directory is not regular: ${path}`);
        await scan(path + '/');
      } else if (assetPath(path)) {
        if (!entry.isFile()) throw new Error(`Interface asset is not a regular file: ${path}`);
        const bytes = await readFile(join(directory, path));
        files.push({ path, bytes: bytes.length, sha256: digest(bytes) });
      }
    }
  }
  await scan();
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const manifest = { format: 1, bridge: BRIDGE, files };
  manifest.revision = digest(JSON.stringify(manifest));
  validateManifest(manifest);
  const pending = join(directory, MANIFEST + '.pending-' + randomUUID());
  try { await writeFile(pending, JSON.stringify(manifest) + '\n'); await rename(pending, join(directory, MANIFEST)); }
  finally { await rm(pending, { force: true }); }
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = await buildInterfaceManifest(fileURLToPath(new URL('../web/dist/', import.meta.url)));
  console.log(`Interface ${manifest.revision.slice(0, 12)}: ${manifest.files.length} verified assets; no machine seed or service worker.`);
}
