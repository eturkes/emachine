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

const section = (title, body) => `## ${title}\n\n---\n\n${body}\n\n---\n\n`;
const sectionHeader = '# Maintain\n\nUse: paste one body between its rules.\n\n';

test('multipart files expose only each named body and accept both steering slots', async t => {
  const f = await fixture(); t.after(() => f.close());
  const queue = 'Work the queue.\n\n  Keep indentation and <request> in prose.';
  const security = 'Review security.\n\n## Checks\nKeep this body heading.';
  await put(f, 'auto/maintain.md', sectionHeader + section('Queue', queue) + section('Security review', security));
  const steered = sectionHeader + section('Request', '<request>\n\nComplete the request.')
    + section('Queue', '<rows>\n\nWork the named rows.');
  await put(f, 'steered/maintain.md', steered.replaceAll('\n', '\r\n'));
  const { prompts } = await catalog(f);
  assert.deepEqual(prompts.map(({ id, ...prompt }) => prompt), [
    { title: 'Maintain: Queue (automatic)', body: queue + '\n', steered: false },
    { title: 'Maintain: Security review (automatic)', body: security + '\n', steered: false },
    { title: 'Maintain: Request (steered)', body: 'Complete the request.\r\n', steered: true },
    { title: 'Maintain: Queue (steered)', body: 'Work the named rows.\r\n', steered: true },
  ]);
  assert.equal(new Set(prompts.map(prompt => prompt.id)).size, 4);
  assert.ok(!JSON.stringify(await f.state()).includes(queue));
});

test('single bodies retain headings, rules and fenced section examples', async t => {
  const f = await fixture(); t.after(() => f.close());
  const body = 'Keep this introduction.\n\n## Instructions\n---\nKeep this rule.\n\n```md\n'
    + section('Example', 'Literal example.') + '```\n\n';
  await put(f, 'auto/single.md', '# Single\n\nUse: paste below.\n\n---\n\n' + body);
  assert.deepEqual((await catalog(f)).prompts, [{
    id: 'claude/prompts/auto/single.md', title: 'Single (automatic)', body, steered: false,
  }]);
});

test('multipart boundaries ignore fenced and indented examples', async t => {
  const f = await fixture(); t.after(() => f.close());
  const body = 'Keep these examples.\n\n````md\n## Example\n---\n```\n---\n````\n'
    + '\n~~~md\n---\n~~~\n\n    ---\n    ## Indented\n\n## Body heading\nFinish here.';
  await put(f, 'auto/maintain.md', sectionHeader + section('Examples', body) + section('Next', 'Only the next prompt.'));
  assert.deepEqual((await catalog(f)).prompts.map(prompt => [prompt.title, prompt.body]), [
    ['Maintain: Examples (automatic)', body + '\n'],
    ['Maintain: Next (automatic)', 'Only the next prompt.\n'],
  ]);
});

test('section IDs retain identity through reordering and distinguish duplicate labels', async t => {
  const f = await fixture(); t.after(() => f.close());
  const source = (first, second) => sectionHeader + section(first, 'First body.') + section(second, 'Second body.');
  await put(f, 'auto/maintain.md', source('Queue', 'Security review'));
  const first = (await catalog(f)).prompts;
  await put(f, 'auto/maintain.md', source('Security review', 'Queue'));
  const reordered = (await catalog(f)).prompts;
  assert.equal(first.length, 2);
  assert.deepEqual(reordered.map(prompt => prompt.title), ['Maintain: Security review (automatic)', 'Maintain: Queue (automatic)']);
  for (const prompt of first) assert.equal(reordered.find(other => other.title === prompt.title).id, prompt.id);
  const labels = ['Queue', 'Queue', 'Queue/2', 'Queue%2F2', 'Caf\u00e9'];
  await put(f, 'auto/maintain.md', sectionHeader + labels.map(label => section(label, 'Body.')).join(''));
  const duplicates = (await catalog(f)).prompts;
  assert.equal(duplicates.length, labels.length);
  assert.equal(new Set(duplicates.map(prompt => prompt.id)).size, labels.length);
});

test('paired closing rules preserve body-final headings', async t => {
  const f = await fixture(); t.after(() => f.close());
  const first = 'Fill these output sections:\n\n## Summary';
  const second = 'Finish this report:\n\n## Result';
  await put(f, 'auto/maintain.md', sectionHeader + section('First', first) + section('Second', second));
  assert.deepEqual((await catalog(f)).prompts.map(prompt => [prompt.title, prompt.body]), [
    ['Maintain: First (automatic)', first + '\n'],
    ['Maintain: Second (automatic)', second + '\n'],
  ]);
});

test('duplicate section identities follow their bodies through catalog reordering', async t => {
  const f = await fixture(); t.after(() => f.close());
  const source = bodies => sectionHeader + bodies.map(body => section('Task', '<request>\n\n' + body)).join('');
  await put(f, 'steered/maintain.md', source(['Body A.', 'Body B.']));
  const first = (await catalog(f)).prompts;
  await put(f, 'steered/maintain.md', source(['Body B.', 'Body A.']));
  const reordered = (await catalog(f)).prompts;
  assert.equal(first.length, 2);
  assert.deepEqual(reordered.map(prompt => prompt.body), ['Body B.\n', 'Body A.\n']);
  for (const prompt of first) assert.equal(reordered.find(other => other.body === prompt.body).id, prompt.id);
});

test('malformed sections are skipped without joining adjacent bodies', async t => {
  const f = await fixture(); t.after(() => f.close());
  await put(f, 'steered/maintain.md', sectionHeader
    + section('Empty', '<request>\n\n')
    + section('Missing slot', 'Do not publish this body.')
    + section('Unknown slot', '<unknown>\n\nDo not publish this body.')
    + section('Queue', '<rows>\n\nKeep these rows.')
    + '## Unclosed\n\n---\n\n<request>\n\nDo not publish this incomplete section.\n');
  assert.deepEqual((await catalog(f)).prompts.map(({ id, ...prompt }) => prompt), [
    { title: 'Maintain: Queue (steered)', body: 'Keep these rows.\n', steered: true },
  ]);
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
