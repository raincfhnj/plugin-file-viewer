/**
 * Viewer-logic tests: the pure half of the TUI file viewer (tree building over
 * a fake loader, change marks, result-line parsing, windows and row labels, and
 * the `message.part.updated` decoder). Rendering itself lives in `tui.tsx` and
 * needs a real TUI — see README for the manual check.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_MAX_DEPTH,
  applyMarks,
  capText,
  clamp,
  contentRows,
  decodeToolEvent,
  findEntryIndex,
  inputPath,
  isViewerTool,
  loadTree,
  markFromStatus,
  normalizeRel,
  parseResultLine,
  treeRows,
  windowSlice,
  type FileNodeLike,
  type SessionDiffLike,
  type TreeEntry,
  type ViewerLoader,
  type VcsStatusLike,
} from '../viewer.ts';

function fakeLoader(tree: Record<string, FileNodeLike[]>, vcs: VcsStatusLike[] = [], files: Record<string, string> = {}): ViewerLoader & { listed: string[] } {
  const listed: string[] = [];
  return {
    listed,
    async list(dir: string) {
      listed.push(dir);
      const rows = tree[dir];
      if (!rows) throw new Error(`ENOENT: ${dir}`);
      return rows;
    },
    async status() {
      return vcs;
    },
    async read(path: string) {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return { type: 'text', content };
    },
  };
}

const ROOT_TREE: Record<string, FileNodeLike[]> = {
  '': [
    { name: 'node_modules', path: 'node_modules\\', type: 'directory', ignored: true },
    { name: '.git', path: '.git\\', type: 'directory', ignored: false },
    { name: 'src', path: 'src\\', type: 'directory', ignored: false },
    { name: 'README.md', path: 'README.md', type: 'file', ignored: false },
  ],
  src: [
    { name: 'zeta.ts', path: 'src\\zeta.ts', type: 'file', ignored: false },
    { name: 'nested', path: 'src\\nested\\', type: 'directory', ignored: false },
    { name: 'alpha.ts', path: 'src\\alpha.ts', type: 'file', ignored: false },
  ],
  'src/nested': [{ name: 'deep.ts', path: 'src/nested/deep.ts', type: 'file', ignored: false }],
};

test('normalizeRel converts separators and strips trailing slashes', () => {
  assert.equal(normalizeRel('adapters\\'), 'adapters');
  assert.equal(normalizeRel('src\\nested\\'), 'src/nested');
  assert.equal(normalizeRel('./src/nested/'), 'src/nested');
  assert.equal(normalizeRel(' README.md '), 'README.md');
  assert.equal(normalizeRel(''), '');
});

test('markFromStatus maps git status words to pane marks', () => {
  assert.equal(markFromStatus('modified'), 'M');
  assert.equal(markFromStatus('added'), 'A');
  assert.equal(markFromStatus('deleted'), 'D');
  assert.equal(markFromStatus(undefined), '?');
  assert.equal(markFromStatus('renamed'), '?');
});

test('loadTree walks depth-first, sorts dirs first and skips hidden/ignored rows', async () => {
  const loader = fakeLoader(ROOT_TREE);
  const entries = await loadTree(loader);
  assert.deepEqual(
    entries.map((e) => `${e.kind}:${e.path}`),
    ['dir:src', 'file:src/zeta.ts', 'dir:src/nested', 'file:src/nested/deep.ts', 'file:src/alpha.ts', 'file:README.md'],
  );
  assert.deepEqual(
    entries.map((e) => e.depth),
    [0, 1, 1, 2, 1, 0],
  );
  assert.ok(!entries.some((e) => e.path.startsWith('node_modules')));
  assert.ok(!entries.some((e) => e.path.startsWith('.git')));
  assert.deepEqual(loader.listed, ['', 'src', 'src/nested']);
});

test('loadTree honours depth and entry caps and degrades when a walk fails', async () => {
  const shallow = await loadTree(fakeLoader(ROOT_TREE), { maxDepth: 0 });
  assert.deepEqual(shallow.map((e) => e.path), ['src', 'README.md']);

  const capped = await loadTree(fakeLoader(ROOT_TREE), { maxEntries: 3 });
  assert.equal(capped.length, 3);

  const broken = fakeLoader({ '': ROOT_TREE[''] });
  const degraded = await loadTree(broken);
  assert.deepEqual(degraded.map((e) => e.path), ['src', 'README.md']);

  const empty = await loadTree(fakeLoader({}));
  assert.deepEqual(empty, []);
  assert.ok(DEFAULT_MAX_DEPTH > 0);
});

test('applyMarks paints git marks, session-only marks and dirty directories', () => {
  const entries: TreeEntry[] = [
    { path: 'src', name: 'src', kind: 'dir', depth: 0, mark: ' ' },
    { path: 'src/a.ts', name: 'a.ts', kind: 'file', depth: 1, mark: ' ' },
    { path: 'src/b.ts', name: 'b.ts', kind: 'file', depth: 1, mark: ' ' },
    { path: 'docs', name: 'docs', kind: 'dir', depth: 0, mark: ' ' },
    { path: 'docs/c.md', name: 'c.md', kind: 'file', depth: 1, mark: ' ' },
    { path: 'README.md', name: 'README.md', kind: 'file', depth: 0, mark: ' ' },
  ];
  const vcs: VcsStatusLike[] = [
    { file: 'src\\a.ts', status: 'modified' },
    { file: 'README.md', status: 'added' },
  ];
  const diff: SessionDiffLike[] = [{ file: 'docs/c.md' }, { file: 'src\\a.ts' }];

  const marked = applyMarks(entries, vcs, diff);
  assert.equal(marked[0].mark, '~'); // src contains a modified file
  assert.equal(marked[1].mark, 'M');
  assert.equal(marked[2].mark, ' ');
  assert.equal(marked[3].mark, '~'); // docs contains a session-only change
  assert.equal(marked[4].mark, '~');
  assert.equal(marked[5].mark, 'A');
  // inputs stay untouched (applyMarks copies rows)
  assert.equal(entries[1].mark, ' ');
});

test('findEntryIndex matches exact paths, then the closest visible ancestor', () => {
  const entries: TreeEntry[] = [
    { path: 'src', name: 'src', kind: 'dir', depth: 0, mark: ' ' },
    { path: 'src/nested', name: 'nested', kind: 'dir', depth: 1, mark: ' ' },
    { path: 'src/nested/deep.ts', name: 'deep.ts', kind: 'file', depth: 2, mark: ' ' },
    { path: 'README.md', name: 'README.md', kind: 'file', depth: 0, mark: ' ' },
  ];
  assert.equal(findEntryIndex(entries, 'src\\nested\\deep.ts'), 2);
  assert.equal(findEntryIndex(entries, 'src'), 0);
  assert.equal(findEntryIndex(entries, 'src/nested/new.ts'), 1); // ancestor directory
  assert.equal(findEntryIndex(entries, 'docs/gone.md'), -1);
  assert.equal(findEntryIndex(entries, 'nope'), -1);
  assert.equal(findEntryIndex(entries, ''), -1);
});

test('parseResultLine resolves content_search and file_search rows only', () => {
  assert.deepEqual(parseResultLine('content_search', 'adapters/opencode/tools.ts:80: export function'), {
    path: 'adapters/opencode/tools.ts',
    line: 80,
  });
  assert.deepEqual(parseResultLine('content_search', 'src\\a.ts:1: x'), { path: 'src/a.ts', line: 1 });
  assert.equal(parseResultLine('content_search', '# content_search "x" matches=2'), undefined);
  assert.equal(parseResultLine('content_search', '(no matches)'), undefined);
  assert.equal(parseResultLine('content_search', 'no line numbers here'), undefined);

  assert.deepEqual(parseResultLine('file_search', '1024  adapters/opencode/tui.tsx'), {
    path: 'adapters/opencode/tui.tsx',
  });
  assert.deepEqual(parseResultLine('file_search', '981  src\\a.ts'), { path: 'src/a.ts' });
  assert.equal(parseResultLine('file_search', '# file_search "x" hits=0 scanned=10'), undefined);
  assert.equal(parseResultLine('file_search', '(no matches)'), undefined);

  assert.equal(parseResultLine('file', 'anything:12: x'), undefined);
  assert.equal(parseResultLine('output', 'anything:12: x'), undefined);
});

test('clamp and windowSlice keep the cursor inside the visible window', () => {
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-1, 0, 3), 0);
  assert.equal(clamp(Number.NaN, 2, 3), 2);
  assert.deepEqual(windowSlice(4, 2, 10), { start: 0, end: 4 });
  assert.deepEqual(windowSlice(100, 50, 10), { start: 45, end: 55 });
  assert.deepEqual(windowSlice(100, 0, 10), { start: 0, end: 10 });
  assert.deepEqual(windowSlice(100, 99, 10), { start: 90, end: 100 });
  assert.deepEqual(windowSlice(0, 0, 10), { start: 0, end: 0 });
});

test('treeRows renders the rowLabel format with the selection slot', () => {
  const entries: TreeEntry[] = [
    { path: 'src', name: 'src', kind: 'dir', depth: 0, mark: '~' },
    { path: 'src/a.ts', name: 'a.ts', kind: 'file', depth: 1, mark: 'M' },
    { path: 'README.md', name: 'README.md', kind: 'file', depth: 0, mark: ' ' },
  ];
  const { rows } = treeRows(entries, 1, 10);
  assert.deepEqual(rows, ['  ~ ▸ src', '> M   a.ts', '    README.md']);

  const windowed = treeRows(
    Array.from({ length: 30 }, (_, i) => ({
      path: `f${i}`,
      name: `f${i}`,
      kind: 'file' as const,
      depth: 0,
      mark: ' ',
    })),
    29,
    5,
  );
  assert.equal(windowed.rows.length, 5);
  assert.equal(windowed.rows[4], '>   f29');
});

test('contentRows numbers lines and windows by offset', () => {
  const lines = ['one', 'two', 'three', 'four'];
  const plain = contentRows(lines, 0, 10, false);
  assert.deepEqual(plain.rows, ['one', 'two', 'three', 'four']);

  const numbered = contentRows(lines, 1, 2, true, 10);
  assert.deepEqual(numbered.rows, ['11  two', '12  three']);
  assert.deepEqual(numbered, { rows: ['11  two', '12  three'], start: 1, end: 3 });

  const past = contentRows(lines, 99, 2, false);
  assert.deepEqual(past.rows, ['four']);

  assert.deepEqual(contentRows([], 0, 5, true), { rows: [], start: 0, end: 0 });
});

test('capText truncates with an explicit note', () => {
  assert.equal(capText('short'), 'short');
  const long = 'x'.repeat(120);
  const capped = capText(long, 100);
  assert.ok(capped.length <= 100);
  assert.match(capped, /\[truncated: kept 100 of 120 chars\]/);
});

test('isViewerTool accepts exactly the four viewer tools', () => {
  assert.equal(isViewerTool('file_tree'), true);
  assert.equal(isViewerTool('content_search'), true);
  assert.equal(isViewerTool('bash'), false);
  assert.equal(isViewerTool(undefined), false);
});

function toolEvent(status: string, tool: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'evt_1',
    type: 'message.part.updated',
    properties: {
      sessionID: 'ses_1',
      part: {
        type: 'tool',
        tool,
        state: { status, input: { path: 'src\\a.ts' }, output: 'body' },
        ...extra,
      },
    },
  };
}

test('decodeToolEvent decodes viewer tool parts and ignores everything else', () => {
  const completed = decodeToolEvent(toolEvent('completed', 'file_diff'));
  assert.ok(completed);
  assert.equal(completed.phase, 'completed');
  assert.equal(completed.tool, 'file_diff');
  assert.equal(completed.output, 'body');
  assert.equal(completed.sessionID, 'ses_1');
  assert.equal(inputPath(completed.input), 'src/a.ts');

  assert.equal(decodeToolEvent(toolEvent('running', 'file_tree'))?.phase, 'running');
  assert.equal(decodeToolEvent(toolEvent('error', 'file_search'))?.phase, 'error');
  assert.equal(decodeToolEvent(toolEvent('pending', 'file_tree')), undefined);
  assert.equal(decodeToolEvent(toolEvent('completed', 'bash')), undefined);
  assert.equal(
    decodeToolEvent({
      id: 'evt_2',
      type: 'message.part.updated',
      properties: { part: { type: 'text', text: 'hi' } },
    }),
    undefined,
  );
  assert.equal(decodeToolEvent({ type: 'session.idle' }), undefined);
  assert.equal(decodeToolEvent(null), undefined);
  assert.equal(decodeToolEvent('nope'), undefined);

  // Tolerated alternate envelope shape (data instead of properties).
  const alt = decodeToolEvent({
    type: 'message.part.updated',
    data: { sessionID: 'ses_2', part: { type: 'tool', tool: 'file_tree', state: { status: 'completed', input: {} } } },
  });
  assert.equal(alt?.sessionID, 'ses_2');
  assert.equal(alt?.output, '');
});

test('inputPath tolerates missing and non-string values', () => {
  assert.equal(inputPath({ path: 'a/b.ts' }), 'a/b.ts');
  assert.equal(inputPath({}), '');
  assert.equal(inputPath({ path: 42 }), '');
});
