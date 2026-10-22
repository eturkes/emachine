import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixture } from './network-helper.mjs';

const exec = promisify(execFile);
const promptRoot = f => join(f.home, '.local/app/agents/claude/prompts');
async function put(f, name, text) {
  const path = join(promptRoot(f), name);
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, text);
}
async function catalog(f) {
  const response = await f.request('api/v1/prompts');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return response.json();
}

test('prompt catalog preserves pasteable bodies and removes the steering slot', async t => {
  const f = await fixture(); t.after(() => f.close());
  const automatic = 'Do the work.\n\n  Preserve indentation and <request> in prose.\n';
  const steered = 'Honor my request above.\r\n\r\n  Preserve caf\u00e9 indentation.\r\n';
  await put(f, 'auto/implement.md', '# Implement\n\nUse: paste below the rule.\n\n---\n\n' + automatic);
  await put(f, 'steered/implement.md', '# Implement\r\n\r\nUse: replace the slot.\r\n\r\n---\r\n\r\n<request>\r\n\r\n' + steered);
  assert.deepEqual(await catalog(f), { prompts: [
    { id: 'claude/prompts/auto/implement.md', title: 'Implement (automatic)', body: automatic, steered: false },
    { id: 'claude/prompts/steered/implement.md', title: 'Implement (steered)', body: steered, steered: true },
  ] });
  assert.ok(!JSON.stringify(await f.state()).includes(automatic));
  await put(f, 'auto/implement.md', '# Implement\n\n---\n\nUpdated body.\n');
  assert.equal((await catalog(f)).prompts[0].body, 'Updated body.\n');
  await rm(join(promptRoot(f), 'steered/implement.md'));
  assert.equal((await catalog(f)).prompts.length, 1);
});

test('prompt variants are grouped and filenames are ordered alphabetically', async t => {
  const f = await fixture(); t.after(() => f.close());
  const names = ['z.md', 'alpha.md', 'alpha-next.md', 'bb.md'];
  for (const variant of ['steered', 'auto']) for (const name of names) {
    await put(f, `${variant}/${name}`, '# Prompt\n---\n' + (variant === 'steered' ? '<request>\n\n' : '') + 'Body.\n');
  }
  const ids = (await catalog(f)).prompts.map(prompt => prompt.id);
  assert.deepEqual(ids, ['auto', 'steered'].flatMap(variant => [...names].sort().map(name => `claude/prompts/${variant}/${name}`)));
});

test('missing sources and malformed templates do not expose unrelated files', async t => {
  const f = await fixture(); t.after(() => f.close());
  assert.deepEqual(await catalog(f), { prompts: [] });
  await put(f, 'auto/good.md', '# Caf\u00e9\n\n---\n\n  Keep this body.\n---\nKeep this rule too.\n');
  await put(f, 'auto/README.md', '# Documentation\n\n---\n\nNot a prompt.\n');
  await put(f, 'auto/missing-rule.md', '# No rule\nNot a template.\n');
  await put(f, 'auto/no-heading.md', 'No heading\n---\nBody.\n');
  await put(f, 'auto/empty.md', '# Empty\n---\n\n');
  await put(f, 'auto/zero.md', '');
  await put(f, 'auto/binary.md', Buffer.concat([Buffer.from('# Binary\n---\n'), Buffer.from([0xff, 0xfe, 0x00])]));
  await put(f, 'auto/ignored.txt', '# Text\n---\nNot Markdown.\n');
  await put(f, 'steered/no-slot.md', '# No slot\n---\nBody.\n');
  await put(f, 'steered/empty-slot.md', '# Empty slot\n---\n<request>\n\n');
  await put(f, 'auto/nested/hidden.md', '# Nested\n---\nNot an immediate prompt.\n');
  await mkdir(join(promptRoot(f), 'auto/directory.md'));
  const outside = join(f.home, 'outside.md'); await writeFile(outside, '# Outside\n---\nPrivate bytes.\n');
  await symlink(outside, join(promptRoot(f), 'auto/escape.md'));
  await exec('mkfifo', [join(promptRoot(f), 'auto/pipe.md')]);
  assert.deepEqual(await catalog(f), { prompts: [{
    id: 'claude/prompts/auto/good.md', title: 'Caf\u00e9 (automatic)',
    body: '  Keep this body.\n---\nKeep this rule too.\n', steered: false,
  }] });
  await rm(join(promptRoot(f), 'steered'), { recursive: true });
  await symlink(f.home, join(promptRoot(f), 'steered'));
  assert.equal((await catalog(f)).prompts.length, 1);
});

test('prompt reads are bounded and use the existing API authorization', async t => {
  const f = await fixture(); t.after(() => f.close());
  const header = '# Boundary\n---\n';
  const body = 'x'.repeat(1048576 - Buffer.byteLength(header));
  await put(f, 'auto/boundary.md', header + body);
  await put(f, 'auto/oversize.md', header + body + 'x');
  const { prompts } = await catalog(f);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].id, 'claude/prompts/auto/boundary.md');
  assert.equal(prompts[0].body.length, body.length);
  assert.equal(prompts[0].body, body);
  for (const headers of [{ Origin: 'https://untrusted.invalid' }, { 'X-Forwarded-For': '203.0.113.1' }]) {
    assert.equal((await f.request('api/v1/prompts', { headers })).status, 403);
  }
  assert.equal((await f.request('api/v1/prompts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
});
