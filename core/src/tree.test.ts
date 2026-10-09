import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DirEntry, GitStatus, Host } from './types.ts';
import {
  DEFAULT_TREE_OPTIONS,
  createTreeState,
  listRows,
  nextChanged,
  select,
  toggle,
} from './tree.ts';

const SHOW_ALL = { changedOnly: false, hideHidden: false } as const;
const SHOW = { changedOnly: false, hideHidden: true } as const;
const CHANGED_ONLY = { changedOnly: true, hideHidden: true } as const;

const d = (name: string): DirEntry => ({ name, kind: 'dir' });
const f = (name: string): DirEntry => ({ name, kind: 'file' });
const sm = (...pairs: Array<[string, GitStatus]>): Map<string, GitStatus> => new Map(pairs);

/** In-memory Host: missing dir (or any listed dir in `throws`) → listDir throws. */
function fakeHost(fs: Record<string, DirEntry[]>, throws: string[] = []): Host {
  return {
    cwd: () => '/repo',
    isWindows: false,
    listDir: async (rel) => {
      if (throws.includes(rel)) throw new Error('EACCES: ' + rel);
      const entries = fs[rel];
      if (!entries) throw new Error('ENOENT: ' + rel);
      return entries.map((e) => ({ ...e }));
    },
    readText: async () => {
      throw new Error('unused');
    },
    exists: async () => false,
    runGit: async () => ({ exitCode: -1, stdout: '', stderr: 'no git' }),
  };
}

/** Host whose every listDir throws — changed-only must never touch it. */
const blindHost: Host = {
  cwd: () => '/repo',
  isWindows: false,
  listDir: async () => {
    throw new Error('filesystem must not be read');
  },
  readText: async () => {
    throw new Error('unused');
  },
  exists: async () => false,
  runGit: async () => ({ exitCode: -1, stdout: '', stderr: 'no git' }),
};

/** Intentionally unordered fixture; also mixes case to pin byte-order sorting. */
function baseFs(): Record<string, DirEntry[]> {
  return {
    '': [
      f('README.md'),
      d('src'),
      f('.hidden'),
      d('.git'),
      d('docs'),
      f('alpha.txt'),
      f('Cargo.toml'),
      d('.github'),
      f('Zeta.txt'),
    ],
    src: [f('main.rs'), d('lib'), f('mod.rs')],
    'src/lib': [f('util.rs')],
    docs: [f('guide.md')],
    '.github': [f('ci.yml')],
  };
}

const paths = (rows: Array<{ path: string }>): string[] => rows.map((r) => r.path);

// ---- options / state -----------------------------------------------------

test('DEFAULT_TREE_OPTIONS: changedOnly off, hideHidden on', () => {
  assert.deepEqual(DEFAULT_TREE_OPTIONS, { changedOnly: false, hideHidden: true });
});

test('createTreeState / toggle / select: immutable state transitions', async () => {
  const s0 = createTreeState();
  assert.equal(s0.root, '');
  assert.ok(s0.expanded.has(''));
  assert.equal(s0.selected, undefined);

  const s1 = toggle(s0, 'src');
  assert.ok(s1.expanded.has('src'));
  assert.ok(!s0.expanded.has('src'), 'toggle returns a new state');
  const s2 = toggle(s1, 'src');
  assert.ok(!s2.expanded.has('src'), 'second toggle collapses');
  assert.ok(s1.expanded.has('src'));

  const sel1 = select('src', 'dir')(s0);
  assert.deepEqual(sel1.selected, { path: 'src', kind: 'dir' });
  assert.equal(s0.selected, undefined, 'select returns a new state');
  const sel2 = select('a.ts', 'file')(sel1);
  assert.deepEqual(sel2.selected, { path: 'a.ts', kind: 'file' });
  assert.deepEqual(sel1.selected, { path: 'src', kind: 'dir' });
});

// ---- ordering ------------------------------------------------------------

test('listRows: directories first, byte order within each group', async () => {
  const rows = await listRows(fakeHost(baseFs()), createTreeState(), sm(), SHOW_ALL);
  assert.deepEqual(paths(rows), [
    '.github',
    'docs',
    'src',
    '.hidden',
    'Cargo.toml',
    'README.md',
    'Zeta.txt',
    'alpha.txt', // 'Z' (0x5A) < 'a' (0x61): code-unit order, not locale order
  ]);
  assert.ok(rows.every((r) => r.depth === 0));
  assert.ok(rows.every((r) => r.expanded === false), 'nothing expanded yet');
  assert.ok(!paths(rows).includes('.git'), '.git is never listed');
});

test('listRows: nested rows are depth-first with correct depths', async () => {
  const st = toggle(toggle(createTreeState(), 'docs'), 'src');
  const rows = await listRows(fakeHost(baseFs()), st, sm(), SHOW);
  assert.deepEqual(rows.map((r) => [r.path, r.depth]), [
    ['docs', 0],
    ['docs/guide.md', 1],
    ['src', 0],
    ['src/lib', 1],
    ['src/main.rs', 1],
    ['src/mod.rs', 1],
    ['Cargo.toml', 0],
    ['README.md', 0],
    ['Zeta.txt', 0],
    ['alpha.txt', 0],
  ]);
});

test('listRows: root can be a subpath and status keys stay repo-relative', async () => {
  const rows = await listRows(
    fakeHost(baseFs()),
    createTreeState('src'),
    sm(['src/main.rs', 'Modified']),
    SHOW,
  );
  assert.deepEqual(paths(rows), ['src/lib', 'src/main.rs', 'src/mod.rs']);
  assert.ok(rows.every((r) => r.depth === 0), "the root's children start at depth 0");
  assert.equal(rows.find((r) => r.path === 'src/main.rs')!.status, 'Modified');
  assert.equal(rows.find((r) => r.path === 'src/lib')!.dirDirty, false);
});

// ---- expand / collapse ---------------------------------------------------

test('listRows: expansion controls which children render', async () => {
  const host = fakeHost(baseFs());
  let rows = await listRows(host, createTreeState(), sm(), SHOW);
  assert.ok(!paths(rows).includes('src/main.rs'), 'collapsed dir shows no children');
  assert.equal(rows.find((r) => r.path === 'src')!.expanded, false);

  const st1 = toggle(createTreeState(), 'src');
  rows = await listRows(host, st1, sm(), SHOW);
  assert.ok(paths(rows).includes('src/main.rs'));
  assert.equal(rows.find((r) => r.path === 'src')!.expanded, true);
  assert.equal(rows.find((r) => r.path === 'src/lib')!.expanded, false);
  assert.ok(!paths(rows).includes('src/lib/util.rs'));

  const st2 = toggle(st1, 'src/lib');
  rows = await listRows(host, st2, sm(), SHOW);
  assert.ok(paths(rows).includes('src/lib/util.rs'));

  rows = await listRows(host, toggle(st2, 'src'), sm(), SHOW);
  assert.ok(!paths(rows).includes('src/main.rs'), 'collapsing hides the whole subtree');
});

test('listRows: toggling a file path leaves the rendered rows unchanged', async () => {
  const host = fakeHost(baseFs());
  const st = toggle(createTreeState(), 'src');
  const before = await listRows(host, st, sm(), SHOW);
  const after = await listRows(host, toggle(st, 'src/main.rs'), sm(), SHOW);
  assert.deepEqual(after, before);
});

test('listRows: empty dir renders its row, no children', async () => {
  const fs = { '': [d('empty'), f('a.txt')], empty: [] as DirEntry[] };
  const rows = await listRows(fakeHost(fs), toggle(createTreeState(), 'empty'), sm(), SHOW);
  assert.deepEqual(rows.map((r) => [r.path, r.kind, r.expanded]), [
    ['empty', 'dir', true],
    ['a.txt', 'file', false],
  ]);
});

test('listRows: listDir errors skip that subtree without failing the walk', async () => {
  const fs = baseFs();
  const rows = await listRows(
    fakeHost(fs, ['src']),
    toggle(createTreeState(), 'src'),
    sm(),
    SHOW,
  );
  assert.ok(paths(rows).includes('src'), 'the dir row itself still renders');
  assert.ok(!paths(rows).includes('src/main.rs'), 'its children are skipped');
  assert.ok(paths(rows).includes('docs'), 'siblings unaffected');

  const rootBroken = await listRows(fakeHost({}), createTreeState(), sm(), SHOW);
  assert.deepEqual(rootBroken, [], 'root listing failure → empty row set');
});

// ---- hideHidden ----------------------------------------------------------

test('listRows: hideHidden drops dot-entries; .git always dropped', async () => {
  const shown = await listRows(fakeHost(baseFs()), createTreeState(), sm(), SHOW);
  assert.deepEqual(paths(shown), ['docs', 'src', 'Cargo.toml', 'README.md', 'Zeta.txt', 'alpha.txt']);

  const all = await listRows(fakeHost(baseFs()), createTreeState(), sm(), SHOW_ALL);
  assert.ok(paths(all).includes('.github'));
  assert.ok(paths(all).includes('.hidden'));
  assert.ok(!paths(all).includes('.git'));
});

// ---- status markers + dirDirty ------------------------------------------

test('listRows: file rows carry their status from statusMap', async () => {
  const st = toggle(toggle(createTreeState(), 'docs'), 'src');
  const rows = await listRows(
    fakeHost(baseFs()),
    st,
    sm(['src/main.rs', 'Deleted'], ['README.md', 'Modified'], ['docs/guide.md', 'Untracked']),
    SHOW,
  );
  assert.equal(rows.find((r) => r.path === 'src/main.rs')!.status, 'Deleted');
  assert.equal(rows.find((r) => r.path === 'README.md')!.status, 'Modified');
  assert.equal(rows.find((r) => r.path === 'docs/guide.md')!.status, 'Untracked');
  assert.equal(rows.find((r) => r.path === 'src/mod.rs')!.status, undefined);
  assert.equal(rows.find((r) => r.path === 'src')!.status, undefined);
});

test('listRows: dirDirty is inferred by prefix for collapsed AND expanded dirs', async () => {
  const statuses = sm(['src/lib/util.rs', 'Modified']);

  const collapsed = await listRows(fakeHost(baseFs()), createTreeState(), statuses, SHOW);
  assert.equal(collapsed.find((r) => r.path === 'src')!.dirDirty, true, 'collapsed dir inferred');
  assert.equal(collapsed.find((r) => r.path === 'docs')!.dirDirty, false);
  assert.equal(collapsed.find((r) => r.path === 'README.md')!.dirDirty, false);

  const expanded = await listRows(fakeHost(baseFs()), toggle(createTreeState(), 'src'), statuses, SHOW);
  assert.equal(expanded.find((r) => r.path === 'src')!.dirDirty, true);
  assert.equal(expanded.find((r) => r.path === 'src/lib')!.dirDirty, true, 'intermediate dir too');
});

test('listRows: dirDirty matches whole path components only', async () => {
  const fs = { '': [d('src'), d('src2')], src: [] as DirEntry[], src2: [f('x.ts')] };
  const rows = await listRows(
    fakeHost(fs),
    createTreeState(),
    sm(['src2/x.ts', 'Modified']),
    SHOW,
  );
  assert.equal(rows.find((r) => r.path === 'src')!.dirDirty, false, 'src2 must not dirty src');
  assert.equal(rows.find((r) => r.path === 'src2')!.dirDirty, true);
});

// ---- baseline changed-set fallback markers (git_tree_markers.rs) ---------

test('changedSet fallback: clean working tree still shows committed markers and dir dots', () => {
  // herdr test: full tree first frame shows committed file and directory markers
  // without pressing `c` — the baseline set fills in where status is empty.
  return listRows(
    fakeHost(baseFs()),
    toggle(createTreeState(), 'src'),
    sm(), // clean working tree
    { ...SHOW, changedSet: sm(['alpha.txt', 'Modified'], ['src/main.rs', 'Modified']) },
  ).then((rows) => {
    assert.equal(rows.find((r) => r.path === 'alpha.txt')!.status, 'Modified');
    assert.equal(rows.find((r) => r.path === 'src/main.rs')!.status, 'Modified');
    assert.equal(rows.find((r) => r.path === 'src')!.dirDirty, true, 'dirty dot from the fallback');
    assert.equal(rows.find((r) => r.path === 'README.md')!.status, undefined);
    assert.equal(rows.find((r) => r.path === 'docs')!.dirDirty, false);
  });
});

test('changedSet fallback: working-tree status wins over the baseline set', () => {
  // herdr test: working_tree_status_keeps_precedence_over_baseline_fallback —
  // a branch-added file subsequently edited is working-tree modified.
  return listRows(
    fakeHost(baseFs()),
    createTreeState(),
    sm(['alpha.txt', 'Modified']),
    { ...SHOW, changedSet: sm(['alpha.txt', 'Added'], ['README.md', 'Added']) },
  ).then((rows) => {
    assert.equal(rows.find((r) => r.path === 'alpha.txt')!.status, 'Modified', 'status wins');
    assert.equal(rows.find((r) => r.path === 'README.md')!.status, 'Added', 'fallback fills gaps');
  });
});

test('changedSet fallback: dirDirty scans the union of both maps', () => {
  const fs: Record<string, DirEntry[]> = {
    '': [d('src'), d('clean'), d('docs')],
    src: [] as DirEntry[],
    clean: [] as DirEntry[],
    docs: [] as DirEntry[],
  };
  return listRows(
    fakeHost(fs),
    createTreeState(),
    sm(['docs/guide.md', 'Modified']), // working-tree dirties docs
    { ...SHOW, changedSet: sm(['src/lib/util.rs', 'Modified']) }, // baseline dirties src
  ).then((rows) => {
    assert.equal(rows.find((r) => r.path === 'docs')!.dirDirty, true);
    assert.equal(rows.find((r) => r.path === 'src')!.dirDirty, true, 'union: src from changedSet');
    assert.equal(rows.find((r) => r.path === 'clean')!.dirDirty, false);
  });
});

test('changedSet: changed-only filters on the baseline set when given (herdr `c`)', () => {
  // The filter source is changedSet, not the working-tree status: committed
  // branch changes appear under `c` even though status is empty for them.
  return listRows(
    blindHost, // synthesized rows never touch the fs
    createTreeState(),
    sm(['stale.txt', 'Modified']), // working-tree-only entry NOT in the baseline set
    { ...CHANGED_ONLY, changedSet: sm(['alpha.txt', 'Modified'], ['docs/guide.md', 'Added']) },
  ).then((rows) => {
    assert.deepEqual(paths(rows), ['docs', 'docs/guide.md', 'alpha.txt']);
    assert.ok(!paths(rows).includes('stale.txt'), 'the filter reads changedSet, not status');
  });
});

test('changedSet: absent → previous behaviour (status is the filter and markers)', () => {
  return listRows(
    blindHost,
    createTreeState(),
    sm(['alpha.txt', 'Modified']),
    CHANGED_ONLY,
  ).then((rows) => {
    assert.deepEqual(paths(rows), ['alpha.txt']);
  });
});

// ---- changed-only --------------------------------------------------------

test('changedOnly: synthesizes changed files + ancestors without touching the fs', async () => {
  const statuses = sm(
    ['src/lib/util.rs', 'Modified'],
    ['docs/guide.md', 'Added'],
    ['new.txt', 'Untracked'],
  );
  const rows = await listRows(blindHost, createTreeState(), statuses, CHANGED_ONLY);
  assert.deepEqual(
    rows.map((r) => [r.path, r.kind, r.depth, r.expanded, r.dirDirty, r.status ?? null]),
    [
      ['docs', 'dir', 0, true, true, null],
      ['docs/guide.md', 'file', 1, false, false, 'Added'],
      ['src', 'dir', 0, true, true, null],
      ['src/lib', 'dir', 1, true, true, null],
      ['src/lib/util.rs', 'file', 2, false, false, 'Modified'],
      ['new.txt', 'file', 0, false, false, 'Untracked'],
    ],
  );
});

test('changedOnly: no changes (non-git repo) → empty row set', async () => {
  const rows = await listRows(blindHost, createTreeState(), new Map(), CHANGED_ONLY);
  assert.deepEqual(rows, []);
});

test('changedOnly: hidden changed files are still listed (no filter in the emitter)', async () => {
  const rows = await listRows(
    blindHost,
    createTreeState(),
    sm(['.github/ci.yml', 'Added']),
    CHANGED_ONLY,
  );
  assert.deepEqual(paths(rows), ['.github', '.github/ci.yml']);
});

test('changedOnly: a non-root tree root scopes the synthesized rows', async () => {
  const rows = await listRows(
    blindHost,
    createTreeState('src'),
    sm(['src/lib/util.rs', 'Modified'], ['docs/guide.md', 'Added']),
    CHANGED_ONLY,
  );
  assert.deepEqual(rows.map((r) => [r.path, r.depth]), [
    ['src/lib', 0],
    ['src/lib/util.rs', 1],
  ]);
});

// ---- nextChanged ---------------------------------------------------------

async function navRows(): Promise<Awaited<ReturnType<typeof listRows>>> {
  const st = toggle(toggle(createTreeState(), 'docs'), 'src');
  return listRows(
    fakeHost(baseFs()),
    st,
    sm(['docs/guide.md', 'Modified'], ['src/main.rs', 'Modified'], ['README.md', 'Modified']),
    SHOW,
  );
}

test('nextChanged: walks changed files in row order and wraps both ways', async () => {
  const rows = await navRows();
  const changed = rows.filter((r) => r.kind === 'file' && r.status).map((r) => r.path);
  assert.deepEqual(changed, ['docs/guide.md', 'src/main.rs', 'README.md'], 'row order, not key order');

  assert.equal(nextChanged(rows, 'docs/guide.md', 1), 'src/main.rs');
  assert.equal(nextChanged(rows, 'src/main.rs', -1), 'docs/guide.md');
  assert.equal(nextChanged(rows, 'README.md', 1), 'docs/guide.md', 'wraps forward');
  assert.equal(nextChanged(rows, 'docs/guide.md', -1), 'README.md', 'wraps backward');
});

test('nextChanged: no current selection lands on an end', async () => {
  const rows = await navRows();
  assert.equal(nextChanged(rows, undefined, 1), 'docs/guide.md');
  assert.equal(nextChanged(rows, undefined, -1), 'README.md');
  assert.equal(nextChanged(rows, 'ghost.ts', 1), 'docs/guide.md');
  assert.equal(nextChanged(rows, 'ghost.ts', -1), 'README.md');
});

test('nextChanged: from a clean file or a dir row, the neighbour in that direction', async () => {
  const rows = await navRows();
  assert.equal(nextChanged(rows, 'src/mod.rs', 1), 'README.md', 'forward past a clean file');
  assert.equal(nextChanged(rows, 'src/mod.rs', -1), 'src/main.rs', 'backward to the changed file above');
  assert.equal(nextChanged(rows, 'Cargo.toml', -1), 'src/main.rs', 'backward across clean rows');
  assert.equal(nextChanged(rows, 'src', 1), 'src/main.rs', 'forward from a dir row');
  assert.equal(nextChanged(rows, 'src', -1), 'docs/guide.md', 'backward from a dir row');
});

test('nextChanged: no changed rows → undefined', async () => {
  const rows = await listRows(fakeHost(baseFs()), createTreeState(), new Map(), SHOW);
  assert.equal(nextChanged(rows, 'README.md', 1), undefined);
  assert.equal(nextChanged(rows, undefined, -1), undefined);
  assert.equal(nextChanged([], 'x', 1), undefined);
});

test('nextChanged: a single changed file jumps to itself', async () => {
  const rows = await listRows(
    fakeHost(baseFs()),
    createTreeState(),
    sm(['README.md', 'Modified']),
    SHOW,
  );
  assert.equal(nextChanged(rows, 'README.md', 1), 'README.md');
  assert.equal(nextChanged(rows, 'Cargo.toml', -1), 'README.md');
});
