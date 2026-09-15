import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { load } from 'js-yaml';

export const updateManifest = 'latest-linux.yml';

export async function validateUpdateMetadata(directory, version, name) {
  const metadata = load(await readFile(join(directory, updateManifest), 'utf8'));
  assert.equal(metadata?.version, version, 'Update metadata version differs from the release.');
  assert.ok(Array.isArray(metadata.files) && metadata.files.length === 1, 'Expected exactly one AppImage in the update feed.');
  const file = metadata.files[0];
  assert.equal(file.url, name, 'Update metadata must point to the release AppImage filename.');
  if (metadata.path !== undefined) assert.equal(metadata.path, name);
  const artifact = join(directory, name);
  assert.equal(file.size, (await stat(artifact)).size, 'Update metadata size differs from the AppImage.');
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(artifact)) hash.update(chunk);
  const digest = hash.digest('base64');
  assert.equal(file.sha512, digest, 'Update metadata checksum differs from the AppImage.');
  if (metadata.sha512 !== undefined) assert.equal(metadata.sha512, digest);
  return metadata;
}
