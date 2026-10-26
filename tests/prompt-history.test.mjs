import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, appendFile, rm, rename, symlink, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixture } from './network-helper.mjs';

const exec = promisify(execFile);
const historyPath = f => join(f.env.CLAUDE_CONFIG_DIR, 'history.jsonl');
const row = (f, display, extra = {}) => ({
  display, pastedContents: {}, timestamp: 1793000000000,
  project: join(f.config.projectRoot, 'alpha'), sessionId: 'session-a', ...extra,
});
async function put(f, rows, suffix = '\n') {
  await mkdir(f.env.CLAUDE_CONFIG_DIR, { recursive: true });
  await writeFile(historyPath(f), rows.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n') + suffix);
}
async function route(f, name = 'alpha') {
  const project = (await f.state()).projects.find(project => project.name === name);
  return 'api/v1/projects/' + project.id + '/prompt-history';
}
async function page(f, path, cursor) {
  const response = await f.request(path + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''));
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const value = await response.json();
  assert.ok(Array.isArray(value.prompts));
  assert.ok(value.nextCursor === null || typeof value.nextCursor === 'string');
  return value;
}

test('project history returns newest recorded prompts with full text and project isolation', async t => {
  const f = await fixture(); t.after(() => f.close());
  const alpha = join(f.config.projectRoot, 'alpha');
  const nested = join(alpha, 'nested'); await mkdir(nested);
  const alias = join(f.home, 'alias'); await symlink(alpha, alias);
  await put(f, [
    row(f, 'First\n  caf\u00e9 \u65e5\u672c\u8a9e \ud83d\ude80', { sessionId: undefined }),
    row(f, 'Other project', { project: join(f.config.projectRoot, 'beta') }),
    row(f, 'Prefix is not a project match', { project: alpha + '-other' }),
    row(f, 'A removed subdirectory', { project: join(alpha, 'removed') }),
    row(f, 'Canonical alias', { project: alias }),
    row(f, 'Nested prompt', { project: nested, timestamp: 1792000000000 }),
    row(f, 'Escaped project', { project: join(alpha, 'nested') + '/../../beta' }),
    row(f, '<img src=x onerror=alert(1)>\r\nLast exact bytes  '),
  ]);
  const value = await page(f, await route(f));
  assert.deepEqual(value.prompts.map(prompt => prompt.body), [
    '<img src=x onerror=alert(1)>\r\nLast exact bytes  ', 'Nested prompt', 'Canonical alias',
    'A removed subdirectory', 'First\n  caf\u00e9 \u65e5\u672c\u8a9e \ud83d\ude80',
  ]);
  assert.equal(new Set(value.prompts.map(prompt => prompt.id)).size, value.prompts.length);
  assert.ok(value.prompts.every(prompt => prompt.incomplete === false));
  assert.equal(value.nextCursor, null);
  assert.deepEqual((await page(f, await route(f, 'beta'))).prompts.map(prompt => prompt.body), ['Escaped project', 'Other project']);
  assert.ok(!JSON.stringify(await f.state()).includes('Last exact bytes'));
});

test('history pagination keeps equal timestamps and repeated prompts through concurrent appends', async t => {
  const f = await fixture(); t.after(() => f.close());
  const rows = Array.from({ length: 125 }, (_, index) => row(f, 'Prompt ' + index));
  rows[30].display = rows[31].display = 'Repeated';
  await put(f, rows);
  const path = await route(f), first = await page(f, path);
  assert.equal(first.prompts.length, 50); assert.ok(first.nextCursor);
  await appendFile(historyPath(f), JSON.stringify(row(f, 'Added later')) + '\n');
  const all = [...first.prompts]; let cursor = first.nextCursor;
  for (let count = 0; cursor && count < 10; count++) {
    const older = await page(f, path, cursor); all.push(...older.prompts);
    assert.notEqual(older.nextCursor, cursor); cursor = older.nextCursor;
  }
  assert.equal(cursor, null);
  assert.deepEqual(all.map(prompt => prompt.body), rows.map(row => row.display).reverse());
  assert.equal(new Set(all.map(prompt => prompt.id)).size, 125);
  assert.equal((await page(f, path)).prompts[0].body, 'Added later');
  const other = await route(f, 'beta');
  assert.equal((await f.request(other + '?cursor=' + encodeURIComponent(first.nextCursor))).status, 400);
});

test('history restores inline and cached text without recursively expanding pasted placeholders', async t => {
  const f = await fixture(); t.after(() => f.close());
  const hash = 'a'.repeat(16), cache = join(f.env.CLAUDE_CONFIG_DIR, 'paste-cache');
  await mkdir(cache, { recursive: true });
  await writeFile(join(cache, hash + '.txt'), 'Cached\n  prompt \u65e5\u672c\u8a9e.\n');
  await put(f, [
    row(f, 'Before [Pasted text #1 +2 lines] and [Pasted text #2 +2 lines].', { pastedContents: {
      1: { id: 1, type: 'text', content: 'Inline [Pasted text #2 +2 lines]\r\ncontent' },
      2: { id: 2, type: 'text', contentHash: hash },
    } }),
    row(f, 'Missing [Pasted text #9 +3 lines] and [Image #2]', { pastedContents: {
      9: { type: 'text', contentHash: 'b'.repeat(64) },
      2: { type: 'image', content: 'Do not expose image data' },
    } }),
  ]);
  const value = await page(f, await route(f));
  assert.equal(value.prompts[0].body, 'Missing [Pasted text #9 +3 lines] and [Image #2]');
  assert.equal(value.prompts[0].incomplete, true);
  assert.equal(value.prompts[1].body, 'Before Inline [Pasted text #2 +2 lines]\r\ncontent and Cached\n  prompt \u65e5\u672c\u8a9e.\n.');
  assert.equal(value.prompts[1].incomplete, false);
});

test('missing history is empty and malformed or oversized records do not hide valid older prompts', async t => {
  const f = await fixture(); t.after(() => f.close());
  const path = await route(f);
  assert.deepEqual(await page(f, path), { prompts: [], nextCursor: null });
  await put(f, [
    row(f, 'Old valid'), 'not json', '{}',
    row(f, 'Invalid timestamp', { timestamp: -1 }),
    row(f, 'Invalid timestamp string', { timestamp: '1793000000000' }),
    row(f, 'x'.repeat(1048577)),
    row(f, '   '), row(f, 'Newest valid'),
  ]);
  await appendFile(historyPath(f), Buffer.from([0xff, 0xfe, 0x0a]));
  await appendFile(historyPath(f), '{"display":"partial');
  let cursor, values = [];
  for (let count = 0; count < 10; count++) {
    const value = await page(f, path, cursor); values.push(...value.prompts.map(prompt => prompt.body));
    cursor = value.nextCursor; if (!cursor) break;
  }
  assert.deepEqual(values, ['Newest valid', 'Old valid']);
});

test('bounded scans make progress across unrelated history and multibyte record boundaries', async t => {
  const f = await fixture(); t.after(() => f.close());
  await put(f, [
    row(f, 'Oldest \u65e5\u672c\u8a9e \ud83d\ude80'),
    ...Array.from({ length: 9 }, (_, index) => row(f, 'Other ' + index + 'x'.repeat(600000), { project: join(f.config.projectRoot, 'beta') })),
    row(f, 'Newest \u65e5\u672c\u8a9e \ud83d\ude80'),
  ]);
  const path = await route(f); let cursor, values = [], emptyPage = false;
  for (let count = 0; count < 10; count++) {
    const value = await page(f, path, cursor); values.push(...value.prompts.map(prompt => prompt.body));
    if (!value.prompts.length && value.nextCursor) emptyPage = true;
    assert.notEqual(value.nextCursor, cursor);
    cursor = value.nextCursor; if (!cursor) break;
  }
  assert.equal(cursor, null); assert.equal(emptyPage, true);
  assert.deepEqual(values, ['Newest \u65e5\u672c\u8a9e \ud83d\ude80', 'Oldest \u65e5\u672c\u8a9e \ud83d\ude80']);
});

test('a matching prompt split inside a UTF-8 character at the scan boundary is returned exactly once', async t => {
  const f = await fixture(); t.after(() => f.close());
  const body = 'Start ' + '\u65e5\u672c\u8a9e \ud83d\ude80'.repeat(45000) + '\n  End';
  const oldest = row(f, 'Oldest'), crossing = row(f, body);
  const crossingBytes = Buffer.from(JSON.stringify(crossing) + '\n');
  const cut = crossingBytes.indexOf(Buffer.from('\u65e5')) + 1;
  const trailing = [
    ...Array.from({ length: 3 }, (_, index) => row(f, 'Other ' + index, { project: join(f.config.projectRoot, 'beta') })),
    row(f, 'Newest'),
  ];
  const trailingBytes = Buffer.byteLength(trailing.map(value => JSON.stringify(value)).join('\n') + '\n');
  const padding = 2097152 - (crossingBytes.length - cut) - trailingBytes;
  assert.ok(padding > 0);
  for (let index = 0; index < 3; index++) {
    trailing[index].display += 'x'.repeat(Math.floor(padding / 3) + (index < padding % 3 ? 1 : 0));
  }
  const rows = [oldest, crossing, ...trailing];
  const encoded = Buffer.from(rows.map(value => JSON.stringify(value)).join('\n') + '\n');
  const boundary = encoded.length - 2097152;
  assert.equal(boundary, Buffer.byteLength(JSON.stringify(oldest) + '\n') + cut);
  assert.equal(encoded[boundary] & 0xc0, 0x80, 'the initial scan starts inside a multibyte character');
  await put(f, rows);
  const path = await route(f), first = await page(f, path);
  assert.deepEqual(first.prompts.map(prompt => prompt.body), ['Newest']);
  const all = [...first.prompts]; let cursor = first.nextCursor;
  for (let count = 0; cursor && count < 8; count++) {
    const older = await page(f, path, cursor); all.push(...older.prompts);
    assert.notEqual(older.nextCursor, cursor); cursor = older.nextCursor;
  }
  assert.equal(cursor, null);
  assert.equal(all.length, 3);
  assert.equal(all[0].body, 'Newest');
  assert.equal(Buffer.compare(Buffer.from(all[1].body), Buffer.from(body)), 0, 'the crossing prompt retains its exact UTF-8 bytes');
  assert.equal(all[2].body, 'Oldest');
  assert.equal(new Set(all.map(prompt => prompt.id)).size, 3);
});

test('an oversized row spanning multiple scans cannot hide older matching prompts', async t => {
  const f = await fixture(); t.after(() => f.close());
  await put(f, [
    row(f, 'Before oversized row'),
    row(f, 'x'.repeat(5 * 1024 * 1024)),
    row(f, 'After oversized row'),
  ]);
  const path = await route(f); let cursor, values = [], emptyPage = false;
  for (let count = 0; count < 10; count++) {
    const value = await page(f, path, cursor); values.push(...value.prompts);
    if (!value.prompts.length && value.nextCursor) emptyPage = true;
    assert.notEqual(value.nextCursor, cursor); cursor = value.nextCursor;
    if (!cursor) break;
  }
  assert.equal(cursor, null);
  assert.equal(emptyPage, true);
  assert.deepEqual(values.map(prompt => prompt.body), ['After oversized row', 'Before oversized row']);
  assert.equal(new Set(values.map(prompt => prompt.id)).size, 2);
});

test('expanded paste bodies that fill a response page leave the withheld prompt for the next page', async t => {
  const f = await fixture(); t.after(() => f.close());
  const hash = 'd'.repeat(16), cache = join(f.env.CLAUDE_CONFIG_DIR, 'paste-cache');
  const pasted = 'Cached\n' + 'x'.repeat(800000);
  await mkdir(cache, { recursive: true }); await writeFile(join(cache, hash + '.txt'), pasted);
  await put(f, ['Oldest', 'Middle', 'Newest'].map(label => row(f, label + ': [Pasted text #1 +2 lines]', {
    pastedContents: { 1: { id: 1, type: 'text', contentHash: hash } },
  })));
  const path = await route(f), first = await page(f, path);
  assert.equal(first.prompts.length, 2);
  assert.ok(first.nextCursor);
  const older = await page(f, path, first.nextCursor);
  assert.equal(older.prompts.length, 1);
  assert.equal(older.nextCursor, null);
  const all = [...first.prompts, ...older.prompts];
  for (const [index, label] of ['Newest', 'Middle', 'Oldest'].entries()) {
    assert.equal(Buffer.compare(Buffer.from(all[index].body), Buffer.from(label + ': ' + pasted)), 0);
    assert.equal(all[index].incomplete, false);
  }
  assert.equal(new Set(all.map(prompt => prompt.id)).size, 3);
});

test('truncation invalidates a snapshot even when the next page offset remains inside the file', async t => {
  const f = await fixture(); t.after(() => f.close());
  const rows = Array.from({ length: 75 }, (_, index) => row(f, 'Prompt ' + String(index).padStart(3, '0')));
  await put(f, rows);
  const path = await route(f), first = await page(f, path);
  assert.equal(first.prompts.length, 50); assert.ok(first.nextCursor);
  assert.equal(first.prompts.at(-1).body, 'Prompt 025');
  const bytesThrough = count => Buffer.byteLength(rows.slice(0, count).map(value => JSON.stringify(value)).join('\n') + '\n');
  const retainedBytes = bytesThrough(65);
  assert.ok(retainedBytes > bytesThrough(25));
  assert.ok(retainedBytes < bytesThrough(rows.length));
  await truncate(historyPath(f), retainedBytes);
  const stale = await f.request(path + '?cursor=' + encodeURIComponent(first.nextCursor));
  assert.equal(stale.status, 400);
  assert.match(await stale.text(), /[Rr]eload history/);
  assert.equal((await page(f, path)).prompts[0].body, 'Prompt 064');
});

test('history rejects stale, malformed and foreign cursors while retaining API authorization', async t => {
  const f = await fixture(); t.after(() => f.close());
  await put(f, Array.from({ length: 60 }, (_, index) => row(f, 'Prompt ' + index)));
  const path = await route(f), first = await page(f, path);
  for (const cursor of ['../elsewhere', '-1', '1', '9'.repeat(1000)]) {
    assert.equal((await f.request(path + '?cursor=' + encodeURIComponent(cursor))).status, 400);
  }
  for (const headers of [{ Origin: 'https://untrusted.invalid' }, { 'X-Forwarded-For': '203.0.113.1' }]) {
    assert.equal((await f.request(path, { headers })).status, 403);
  }
  assert.equal((await f.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
  assert.equal((await f.request('api/v1/projects/not-a-project/prompt-history')).status, 400);
  await rename(historyPath(f), historyPath(f) + '.old');
  await put(f, [row(f, 'Rotated')]);
  assert.equal((await f.request(path + '?cursor=' + encodeURIComponent(first.nextCursor))).status, 400);
  assert.deepEqual((await page(f, path)).prompts.map(prompt => prompt.body), ['Rotated']);
});

test('history and paste cache accept only bounded regular files inside their owning directory', async t => {
  const f = await fixture(); t.after(() => f.close());
  const path = await route(f), cache = join(f.env.CLAUDE_CONFIG_DIR, 'paste-cache');
  await mkdir(cache, { recursive: true });
  const outside = join(f.home, 'outside.txt'); await writeFile(outside, 'Private outside bytes.');
  const hash = 'c'.repeat(16);
  await symlink(outside, join(cache, hash + '.txt'));
  await put(f, [row(f, 'Read [Pasted text #1 +1 lines]', { pastedContents: { 1: { type: 'text', contentHash: hash } } })]);
  let value = await page(f, path);
  assert.equal(value.prompts[0].incomplete, true);
  assert.ok(!JSON.stringify(value).includes('Private outside bytes'));
  await rm(historyPath(f)); await symlink(outside, historyPath(f));
  assert.notEqual((await f.request(path)).status, 200);
  await rm(historyPath(f)); await exec('mkfifo', [historyPath(f)]);
  assert.notEqual((await f.request(path)).status, 200);
});
