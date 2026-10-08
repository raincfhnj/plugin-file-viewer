import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSearchable, searchContent } from './search.ts';
import type { DirEntry, Host, RunResult } from './types.ts';

interface FakeOptions {
  /** Byte-size overrides per path (DirEntry.size). */
  sizes?: Record<string, number>;
  /** Paths whose DirEntry omits size (host does not know it). */
  omitSize?: string[];
  /** Paths whose readText throws (deleted mid-scan / unreadable). */
  unreadable?: string[];
}

interface FakeHost extends Host {
  /** Paths passed to readText, in call order. */
  reads: string[];
  /** Paths passed to listDir, in call order. */
  lists: string[];
}

const parentOf = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
};
const nameOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

/** In-memory Host over a map of repo-root-relative POSIX paths -> file text. */
function makeHost(files: Record<string, string>, opts: FakeOptions = {}): FakeHost {
  const dirs = new Set<string>(['']);
  for (const p of Object.keys(files)) {
    let d = parentOf(p);
    while (!dirs.has(d)) {
      dirs.add(d);
      d = parentOf(d);
    }
  }
  const reads: string[] = [];
  const lists: string[] = [];
  return {
    reads,
    lists,
    cwd: () => '/repo',
    isWindows: false,
    async listDir(rel: string): Promise<DirEntry[]> {
      lists.push(rel);
      const out: DirEntry[] = [];
      for (const d of dirs) {
        if (d !== '' && parentOf(d) === rel) out.push({ name: nameOf(d), kind: 'dir' });
      }
      for (const p of Object.keys(files)) {
        if (parentOf(p) !== rel) continue;
        if (opts.omitSize?.includes(p)) out.push({ name: nameOf(p), kind: 'file' });
        else {
          const size = opts.sizes?.[p] ?? files[p].length;
          out.push({ name: nameOf(p), kind: 'file', size });
        }
      }
      return out;
    },
    async readText(rel: string): Promise<string> {
      reads.push(rel);
      if (opts.unreadable?.includes(rel)) throw new Error(`unreadable: ${rel}`);
      if (!(rel in files)) throw new Error(`missing: ${rel}`);
      return files[rel];
    },
    async exists(rel: string): Promise<boolean> {
      return rel in files || dirs.has(rel);
    },
    async runGit(): Promise<RunResult> {
      return { exitCode: -1, stdout: '', stderr: 'no git in fake host' };
    },
  };
}

test('isSearchable accepts text extensions and rejects binaries', () => {
  for (const yes of ['src/a.ts', 'docs/README.md', 'X.TS', 'deep/nested/file.py']) {
    assert.equal(isSearchable(yes), true, yes);
  }
  for (const no of ['img/logo.png', 'bin/app.exe', 'photo.jpg', 'archive.zip']) {
    assert.equal(isSearchable(no), false, no);
  }
});

test('searchContent returns path:line rows with a trimmed excerpt', async () => {
  const host = makeHost({ 'src/app.ts': 'alpha\nbeta needle\ngamma\n' });
  const hits = await searchContent(host, '', 'needle');
  assert.deepEqual(hits, [{ path: 'src/app.ts', line: 2, text: 'beta needle' }]);
});

test('matching is case-insensitive in both directions', async () => {
  const host = makeHost({ 'a.ts': 'has needle\n', 'b.ts': 'NEEDLE!\n' });
  assert.deepEqual(await searchContent(host, '', 'NEEDLE'), [
    { path: 'a.ts', line: 1, text: 'has needle' },
    { path: 'b.ts', line: 1, text: 'NEEDLE!' },
  ]);
  assert.deepEqual(await searchContent(host, '', 'needle'), [
    { path: 'a.ts', line: 1, text: 'has needle' },
    { path: 'b.ts', line: 1, text: 'NEEDLE!' },
  ]);
});

test('root "" yields bare relative paths and nested dirs are walked', async () => {
  const host = makeHost({ 'top.ts': 'hit\n', 'src/deep/x.ts': 'hit\n' });
  const hits = await searchContent(host, '', 'hit');
  assert.deepEqual(
    hits.map((h) => h.path),
    ['src/deep/x.ts', 'top.ts'],
  );
  assert.ok(hits.every((h) => !h.path.startsWith('/') && !h.path.startsWith('./')));
});

test('a subdirectory root keeps its prefix on every path', async () => {
  const host = makeHost({ 'src/a.ts': 'hit\n', 'lib/b.ts': 'hit\n' });
  const hits = await searchContent(host, 'src', 'hit');
  assert.deepEqual(hits, [{ path: 'src/a.ts', line: 1, text: 'hit' }]);
});

test('limit truncates in file-name order and stops reading further files', async () => {
  const host = makeHost({ 'c.ts': 'x\n', 'a.ts': 'x\n', 'b.ts': 'x\n' });
  const hits = await searchContent(host, '', 'x', { limit: 2 });
  assert.deepEqual(
    hits.map((h) => h.path),
    ['a.ts', 'b.ts'],
  );
  assert.equal(hits.length, 2, 'never exceeds the limit');
  assert.deepEqual(host.reads, ['a.ts', 'b.ts'], 'c.ts is never read');
});

test('limit 0 and an empty query return nothing without touching the host', async () => {
  const host = makeHost({ 'a.ts': 'x\n' });
  assert.deepEqual(await searchContent(host, '', 'x', { limit: 0 }), []);
  assert.deepEqual(await searchContent(host, '', ''), []);
  assert.deepEqual(host.lists, []);
  assert.deepEqual(host.reads, []);
});

test('files over maxFileBytes are skipped without being read', async () => {
  const host = makeHost(
    { 'big.ts': 'needle\n', 'small.ts': 'needle\n' },
    { sizes: { 'big.ts': 10 * 1024 * 1024 } },
  );
  const hits = await searchContent(host, '', 'needle', { maxFileBytes: 1024 });
  assert.deepEqual(
    hits.map((h) => h.path),
    ['small.ts'],
  );
  assert.deepEqual(host.reads, ['small.ts']);
});

test('oversized content is skipped when the host omits the size', async () => {
  const host = makeHost({ 'big.ts': 'needle '.repeat(50) }, { omitSize: ['big.ts'] });
  const hits = await searchContent(host, '', 'needle', { maxFileBytes: 10 });
  assert.deepEqual(hits, []);
});

test('non-text extensions are never read', async () => {
  const host = makeHost({ 'img.png': 'needle', 'a.ts': 'needle' });
  const hits = await searchContent(host, '', 'needle');
  assert.deepEqual(
    hits.map((h) => h.path),
    ['a.ts'],
  );
  assert.deepEqual(host.reads, ['a.ts']);
});

test('binary content containing NUL is skipped (repo_search.rs sniff)', async () => {
  const nul = String.fromCharCode(0);
  const host = makeHost({ 'data.txt': `${nul}needle`, 'ok.txt': 'needle' });
  const hits = await searchContent(host, '', 'needle');
  assert.deepEqual(
    hits.map((h) => h.path),
    ['ok.txt'],
  );
});

test('hidden entries, .git and node_modules are skipped', async () => {
  const host = makeHost({
    '.secret/a.ts': 'needle\n',
    '.git/b.ts': 'needle\n',
    'node_modules/pkg/index.ts': 'needle\n',
    'src/c.ts': 'needle\n',
  });
  const hits = await searchContent(host, '', 'needle');
  assert.deepEqual(
    hits.map((h) => h.path),
    ['src/c.ts'],
  );
});

test('unreadable files are skipped without failing the search', async () => {
  const host = makeHost({ 'a.ts': 'needle\n', 'b.ts': 'needle\n' }, { unreadable: ['a.ts'] });
  const hits = await searchContent(host, '', 'needle');
  assert.deepEqual(
    hits.map((h) => h.path),
    ['b.ts'],
  );
});

test('results follow file-name order regardless of listDir order', async () => {
  const host = makeHost({ 'b.ts': 'x\n', 'a.ts': 'x\n', 'z/m.ts': 'x\n' });
  const hits = await searchContent(host, '', 'x');
  assert.deepEqual(
    hits.map((h) => h.path),
    ['a.ts', 'b.ts', 'z/m.ts'],
  );
});

test('one hit per line: the first occurrence only', async () => {
  const host = makeHost({ 'a.ts': 'x x x\nx\n' });
  const hits = await searchContent(host, '', 'x');
  assert.deepEqual(hits, [
    { path: 'a.ts', line: 1, text: 'x x x' },
    { path: 'a.ts', line: 2, text: 'x' },
  ]);
});

test('CRLF line endings do not leak into the excerpt', async () => {
  const host = makeHost({ 'a.ts': 'first\r\nneedle  \r\n' });
  const hits = await searchContent(host, '', 'needle');
  assert.deepEqual(hits, [{ path: 'a.ts', line: 2, text: 'needle' }]);
});

test('short lines are excerpted as the trimmed line', async () => {
  const host = makeHost({ 'a.ts': '  padded needle here  \n' });
  const hits = await searchContent(host, '', 'needle');
  assert.deepEqual(hits, [{ path: 'a.ts', line: 1, text: 'padded needle here' }]);
});

test('long lines are windowed around the match with ellipses', async () => {
  const line = 'a'.repeat(300) + ' needle ' + 'b'.repeat(300);
  const host = makeHost({ 'f.ts': line });
  const hits = await searchContent(host, '', 'needle');
  assert.equal(hits.length, 1);
  const text = hits[0].text;
  assert.ok(text.includes('needle'), 'excerpt keeps the match');
  assert.ok(text.startsWith('…'), 'leading ellipsis');
  assert.ok(text.endsWith('…'), 'trailing ellipsis');
  assert.ok(Array.from(text).length <= 162, `excerpt bounded (got ${Array.from(text).length})`);
});

test('an excerpt keeps a long match whole (repo_search.rs excerpt_keeps_a_long_match_whole)', async () => {
  const query = 'needle'.repeat(40);
  const host = makeHost({ 'f.ts': `prefix ${query} suffix` });
  const hits = await searchContent(host, '', query);
  assert.equal(hits.length, 1);
  assert.ok(hits[0].text.includes(query), 'the full match stays visible');
});
