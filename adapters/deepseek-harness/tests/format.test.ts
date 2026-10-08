import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDiff, formatSearch, formatTreeRows, statusMarker } from '../src/format.ts';
import type { TreeNode } from '../src/core/types.ts';

const dir = (path: string, depth: number, dirDirty = false): TreeNode => ({
  path,
  kind: 'dir',
  depth,
  expanded: true,
  dirDirty,
});
const file = (path: string, depth: number, status?: TreeNode['status']): TreeNode => ({
  path,
  kind: 'file',
  depth,
  expanded: false,
  dirDirty: false,
  status,
});

test('statusMarker maps every status', () => {
  assert.equal(statusMarker('Modified'), 'M');
  assert.equal(statusMarker('Added'), 'A');
  assert.equal(statusMarker('Deleted'), 'D');
  assert.equal(statusMarker('Untracked'), '?');
});

test('formatTreeRows: indentation, markers, legend', () => {
  const text = formatTreeRows(
    [
      dir('src', 0, true),
      file('src/index.ts', 1, 'Modified'),
      file('README.md', 0, 'Untracked'),
    ],
    { title: '# tree' },
  );
  const lines = text.split('\n');
  assert.equal(lines[0], '# tree');
  assert.ok(lines[1]!.startsWith('src/'));
  assert.ok(lines[1]!.endsWith(' *'));
  assert.equal(lines[2], '  index.ts [M]');
  assert.equal(lines[3], 'README.md [?]');
  assert.ok(text.includes('[M] modified'));
  assert.ok(!text.includes('truncated'));
});

test('formatTreeRows: truncation note with counts', () => {
  const rows = Array.from({ length: 10 }, (_, i) => file(`f${i}.ts`, 0));
  const text = formatTreeRows(rows, { maxRows: 4 });
  assert.ok(text.includes('truncated: 4 of 10 rows'));
  assert.equal(text.split('\n').filter((l) => l.startsWith('f')).length, 4);
});

test('formatTreeRows: clean tree prints no legend', () => {
  const text = formatTreeRows([file('a.txt', 0)]);
  assert.ok(!text.includes('[M]'));
});

test('formatDiff: empty text reports no differences', () => {
  assert.equal(
    formatDiff('src/a.ts', 'HEAD', ''),
    '# diff src/a.ts vs HEAD\n(no differences)',
  );
});

test('formatDiff: passes short diffs through untouched', () => {
  const diff = 'diff --git a/src/a.ts b/src/a.ts\n+new';
  assert.equal(formatDiff('src/a.ts', 'Base', diff), `# diff src/a.ts vs Base\n${diff}`);
});

test('formatDiff: truncates long diffs with a note', () => {
  const diff = 'x'.repeat(600);
  const text = formatDiff('a.ts', 'HEAD', diff, { maxChars: 300 });
  assert.ok(text.includes('truncated: 300 of 600 characters'));
  assert.ok(text.startsWith('# diff a.ts vs HEAD\n'));
});

test('formatSearch: rows, zero matches, and limit note', () => {
  const hit = formatSearch(
    [
      { path: 'src/a.ts', line: 3, text: 'const needle = 1' },
      { path: 'src/b.ts', line: 9, text: 'needle();' },
    ],
    { query: 'needle', limit: 2, limitHit: true },
  );
  assert.ok(hit.startsWith('2 match(es) for "needle"'));
  assert.ok(hit.includes('src/a.ts:3: const needle = 1'));
  assert.ok(hit.includes('truncated at limit=2'));

  assert.equal(formatSearch([], { query: 'zzz' }), 'no matches for "zzz"');
});
