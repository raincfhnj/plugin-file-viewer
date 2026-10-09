import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Host, RunResult } from './types.ts';
import {
  EMPTY_TREE,
  FULL_CONTEXT,
  SAFE_DIFF_FLAGS,
  SAFE_GIT_ENV,
  SAFE_GIT_FLAGS,
  changedSet,
  classify,
  classifyNameStatus,
  currentBranch,
  defaultBaseBranch,
  defaultBaseline,
  fileDiff,
  isRepo,
  normalizeNoIndex,
  parseNameStatus,
  parsePorcelainStatus,
  repoRoot,
  safeRun,
  status,
} from './git.ts';

const NUL = String.fromCharCode(0);

/** NUL-terminated `-z` fields, exactly as `git status -z` emits them. */
const z = (...fields: string[]): string => fields.map((f) => f + NUL).join('');

const OK = (stdout = ''): RunResult => ({ exitCode: 0, stdout, stderr: '' });
const FAIL = (exitCode = 128, stderr = 'fatal: boom'): RunResult => ({
  exitCode,
  stdout: '',
  stderr,
});

/** Fake Host: records every runGit argv, routes on the subcommand. */
function fakeHost(route: (args: string[]) => RunResult, isWindows = false): {
  host: Host;
  calls: string[][];
} {
  const calls: string[][] = [];
  const host: Host = {
    cwd: () => '/repo',
    isWindows,
    listDir: async () => [],
    readText: async () => '',
    exists: async () => false,
    runGit: async (_dir, args) => {
      calls.push([...args]);
      return route(args);
    },
  };
  return { host, calls };
}

// ---- parsePorcelainStatus ------------------------------------------------

test('parsePorcelainStatus: M/A/D/?? records', () => {
  const map = parsePorcelainStatus(z(' M src/a.ts', 'A  docs/new.md', ' D old.md', '?? u.txt'));
  assert.equal(map.get('src/a.ts'), 'Modified');
  assert.equal(map.get('docs/new.md'), 'Added');
  assert.equal(map.get('old.md'), 'Deleted');
  assert.equal(map.get('u.txt'), 'Untracked');
  assert.equal(map.size, 4);
});

test('parsePorcelainStatus: rename consumes the original-path field, keys the new path', () => {
  const map = parsePorcelainStatus(z('RM new.txt', 'old.txt', ' M after.txt'));
  assert.equal(map.get('new.txt'), 'Modified', "rename's NEW path is keyed (R → Modified)");
  assert.equal(map.has('old.txt'), false, "rename's old path is consumed, not keyed");
  assert.equal(map.get('after.txt'), 'Modified', 'the record after the rename parses (no desync)');
  assert.equal(map.size, 2);
});

test('parsePorcelainStatus: copy consumes its original-path field', () => {
  const map = parsePorcelainStatus(z('CM c.txt', 'orig.txt', '?? u.txt'));
  assert.equal(map.get('c.txt'), 'Modified');
  assert.equal(map.has('orig.txt'), false);
  assert.equal(map.get('u.txt'), 'Untracked');
});

test('parsePorcelainStatus: rename with a missing original-path field does not throw', () => {
  const map = parsePorcelainStatus(z('RM only.txt'));
  assert.equal(map.get('only.txt'), 'Modified');
});

test('parsePorcelainStatus: truncated records are skipped, the rest still parse', () => {
  const map = parsePorcelainStatus(z('', 'X', 'XY', '??', ' M mod.txt'));
  assert.equal(map.size, 1, 'only the well-formed record survives');
  assert.equal(map.get('mod.txt'), 'Modified');
});

test('parsePorcelainStatus: unknown XY codes map to Modified (git.rs parity)', () => {
  const map = parsePorcelainStatus(z('ZZ weird.txt', 'UU conflict.txt'));
  assert.equal(map.get('weird.txt'), 'Modified');
  assert.equal(map.get('conflict.txt'), 'Modified');
});

test('parsePorcelainStatus: backslash separators normalize to POSIX', () => {
  const map = parsePorcelainStatus('?? src\\dir\\file.txt' + NUL);
  assert.equal(map.get('src/dir/file.txt'), 'Untracked');
});

test('parsePorcelainStatus: spaces and non-ASCII survive NUL field splits', () => {
  const map = parsePorcelainStatus(z('?? my file.txt', '?? résumé.txt'));
  assert.equal(map.get('my file.txt'), 'Untracked');
  assert.equal(map.get('résumé.txt'), 'Untracked');
});

test('parsePorcelainStatus: empty input → empty map', () => {
  assert.equal(parsePorcelainStatus('').size, 0);
  assert.equal(parsePorcelainStatus(NUL + NUL).size, 0);
});

// ---- classify ------------------------------------------------------------

test('classify: every porcelain XY branch', () => {
  const cases: Array<[string, string | undefined]> = [
    // Untracked — the `??` branch.
    ['??', 'Untracked'],
    // Deleted — any code containing D (staged, unstaged, both); D wins over A/M.
    [' D', 'Deleted'],
    ['D ', 'Deleted'],
    ['DD', 'Deleted'],
    ['MD', 'Deleted'],
    ['AD', 'Deleted'],
    // Added — contains A and not D; A wins over M.
    ['A ', 'Added'],
    [' A', 'Added'],
    ['AM', 'Added'],
    // Modified — every other non-empty code (M/T/R/C, unmerged, unknown).
    [' M', 'Modified'],
    ['M ', 'Modified'],
    ['MM', 'Modified'],
    ['MR', 'Modified'],
    ['MT', 'Modified'],
    ['RM', 'Modified'],
    ['C ', 'Modified'],
    ['TM', 'Modified'],
    // Blank / whitespace-only → None (unmodified).
    ['', undefined],
    ['  ', undefined],
    // Unknown but non-empty → Modified catch-all (UU = unmerged, ZZ = future code).
    ['ZZ', 'Modified'],
    ['UU', 'Modified'],
    ['!!', 'Modified'],
  ];
  for (const [code, want] of cases) {
    assert.equal(classify(code), want, `classify(${JSON.stringify(code)})`);
  }
});

// ---- normalizeNoIndex ----------------------------------------------------

test('normalizeNoIndex: rewrites headers to a plain add of the path', () => {
  const raw = [
    'diff --git a/dev/null b/src/x.md',
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    '+++ b/src/old.md',
    '@@ -0,0 +1 @@',
    '+hi',
  ].join('\n');
  const out = normalizeNoIndex(raw, 'src/x.md');
  assert.equal(
    out,
    [
      'diff --git a/src/x.md b/src/x.md',
      'new file mode 100644',
      'index 0000000..1111111',
      '--- /dev/null',
      '+++ b/src/x.md',
      '@@ -0,0 +1 @@',
      '+hi',
    ].join('\n'),
  );
});

// ---- status / isRepo / repoRoot -----------------------------------------

test('status: parses runGit output; failure → empty map', async () => {
  const ok = fakeHost((args) => (args[0] === 'status' ? OK(z(' M a.ts')) : FAIL()));
  assert.equal((await status(ok.host, '/repo')).get('a.ts'), 'Modified');
  assert.deepEqual(ok.calls[0], ['status', '--porcelain=v1', '-z', '-uall']);
  const bad = fakeHost(() => FAIL(-1, 'not a git repository'));
  assert.equal((await status(bad.host, '/repo')).size, 0);
});

test('isRepo: true only for "true" on exit 0', async () => {
  assert.equal(await isRepo(fakeHost(() => OK('true\n')).host, '/repo'), true);
  assert.equal(await isRepo(fakeHost(() => OK('false\n')).host, '/repo'), false);
  assert.equal(await isRepo(fakeHost(() => FAIL(-1)).host, '/repo'), false);
});

test('repoRoot: trims and POSIX-normalizes; failure → undefined', async () => {
  const win = fakeHost(() => OK('C:\\repo\\proj\r\n'));
  assert.equal(await repoRoot(win.host, '/repo'), 'C:/repo/proj');
  const bad = fakeHost(() => FAIL(-1));
  assert.equal(await repoRoot(bad.host, '/repo'), undefined);
});

// ---- defaultBaseBranch ---------------------------------------------------

test('defaultBaseBranch: origin/HEAD symbolic ref wins', async () => {
  const h = fakeHost((args) =>
    args[0] === 'symbolic-ref' ? OK('refs/remotes/origin/main\n') : FAIL(),
  );
  assert.equal(await defaultBaseBranch(h.host, '/repo'), 'origin/main');
  assert.deepEqual(h.calls, [['symbolic-ref', 'refs/remotes/origin/HEAD']]);
});

test('defaultBaseBranch: falls back origin/main → origin/master → main → master', async () => {
  const h = fakeHost((args) =>
    args[0] === 'symbolic-ref' ? FAIL(1) : args[2] === 'master' ? OK('master\n') : FAIL(1),
  );
  assert.equal(await defaultBaseBranch(h.host, '/repo'), 'master');
  const candidates = h.calls.filter((c) => c[0] === 'rev-parse').map((c) => c[2]);
  assert.deepEqual(candidates, ['origin/main', 'origin/master', 'main', 'master']);
});

test('defaultBaseBranch: undefined when nothing resolves', async () => {
  assert.equal(await defaultBaseBranch(fakeHost(() => FAIL(-1)).host, '/repo'), undefined);
});

// ---- fileDiff ------------------------------------------------------------

test('fileDiff HEAD: status probe then git diff HEAD -- path', async () => {
  const h = fakeHost((args) => {
    if (args[0] === 'status') return OK(z(' M src/a.ts'));
    if (args[0] === 'diff') return OK('DIFF');
    return FAIL();
  });
  assert.equal(await fileDiff(h.host, '/repo', 'src\\a.ts', 'HEAD'), 'DIFF');
  assert.deepEqual(h.calls, [
    ['status', '--porcelain=v1', '-z', '-uall'],
    ['diff', ...SAFE_DIFF_FLAGS, 'HEAD', '--', 'src/a.ts'],
  ]);
});

test('fileDiff HEAD fullContext: -U1000000 before the revision', async () => {
  const h = fakeHost((args) => (args[0] === 'status' ? OK('') : OK('FULL')));
  await fileDiff(h.host, '/repo', 'a.ts', 'HEAD', { fullContext: true });
  assert.deepEqual(h.calls[1], ['diff', ...SAFE_DIFF_FLAGS, FULL_CONTEXT, 'HEAD', '--', 'a.ts']);
});

test('fileDiff HEAD: unborn HEAD retries against the empty tree', async () => {
  const h = fakeHost((args) => {
    if (args[0] === 'status') return OK(z('A fresh.txt'));
    if (args[0] === 'diff') {
      return args.includes('HEAD') ? FAIL(128, "fatal: bad revision 'HEAD'") : OK('VS-EMPTY');
    }
    return FAIL();
  });
  assert.equal(await fileDiff(h.host, '/repo', 'fresh.txt', 'HEAD'), 'VS-EMPTY');
  assert.deepEqual(h.calls[1], ['diff', ...SAFE_DIFF_FLAGS, 'HEAD', '--', 'fresh.txt']);
  assert.deepEqual(h.calls[2], ['diff', ...SAFE_DIFF_FLAGS, EMPTY_TREE, '--', 'fresh.txt']);
});

const RAW_NOINDEX = [
  'diff --git a/dev/null b/u.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/u.txt',
  '@@ -0,0 +1 @@',
  '+x',
  '',
].join('\n');

const EXPECTED_NOINDEX = [
  'diff --git a/u.txt b/u.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/u.txt',
  '@@ -0,0 +1 @@',
  '+x',
  '',
].join('\n');

test('fileDiff HEAD: untracked → git diff --no-index against /dev/null (exit 1 ok)', async () => {
  const h = fakeHost((args) => {
    if (args[0] === 'status') return OK(z('?? u.txt'));
    if (args[0] === 'diff') return { exitCode: 1, stdout: RAW_NOINDEX, stderr: '' };
    return FAIL();
  });
  assert.equal(await fileDiff(h.host, '/repo', 'u.txt', 'HEAD'), EXPECTED_NOINDEX);
  assert.deepEqual(h.calls[1], [
    'diff',
    ...SAFE_DIFF_FLAGS,
    '--no-index',
    '--',
    '/dev/null',
    'u.txt',
  ]);
});

test('fileDiff HEAD: untracked uses NUL as the null device on Windows', async () => {
  const h = fakeHost(
    (args) =>
      (args[0] === 'status' ? OK(z('?? u.txt')) : { exitCode: 1, stdout: RAW_NOINDEX, stderr: '' }),
    true,
  );
  await fileDiff(h.host, '/repo', 'u.txt', 'HEAD');
  assert.deepEqual(h.calls[1], ['diff', ...SAFE_DIFF_FLAGS, '--no-index', '--', 'NUL', 'u.txt']);
});

test('fileDiff Base: merge-base against the supplied base branch', async () => {
  const h = fakeHost((args) => {
    if (args[0] === 'merge-base') return OK('FROMSHA\n');
    if (args[0] === 'status') return OK('');
    if (args[0] === 'diff') return OK('BASE');
    return FAIL();
  });
  assert.equal(await fileDiff(h.host, '/repo', 'a.ts', 'Base', { baseBranch: 'origin/main' }), 'BASE');
  assert.deepEqual(h.calls, [
    ['merge-base', 'HEAD', 'origin/main'],
    ['status', '--porcelain=v1', '-z', '-uall'],
    ['diff', ...SAFE_DIFF_FLAGS, 'FROMSHA', '--', 'a.ts'],
  ]);
});

test('fileDiff Base: detects the base branch when none is supplied', async () => {
  const h = fakeHost((args) => {
    if (args[0] === 'symbolic-ref') return FAIL(1);
    if (args[0] === 'rev-parse') return args[2] === 'main' ? OK('main\n') : FAIL(1);
    if (args[0] === 'merge-base') return OK('SHA\n');
    if (args[0] === 'status') return OK('');
    if (args[0] === 'diff') return OK('D');
    return FAIL();
  });
  assert.equal(await fileDiff(h.host, '/repo', 'a.ts', 'Base'), 'D');
  assert.deepEqual(h.calls.find((c) => c[0] === 'merge-base'), ['merge-base', 'HEAD', 'main']);
  assert.deepEqual(h.calls[h.calls.length - 1], ['diff', ...SAFE_DIFF_FLAGS, 'SHA', '--', 'a.ts']);
});

test('fileDiff Base: no base branch resolves → falls back to HEAD behaviour', async () => {
  const h = fakeHost((args) => {
    if (args[0] === 'status') return OK(z(' M a.ts'));
    if (args[0] === 'symbolic-ref' || args[0] === 'rev-parse') return FAIL(1);
    if (args[0] === 'diff') return OK('HEADDIFF');
    return FAIL();
  });
  assert.equal(await fileDiff(h.host, '/repo', 'a.ts', 'Base'), 'HEADDIFF');
  assert.ok(h.calls.some((c) => c[0] === 'diff' && c.includes('HEAD')));
});

test('fileDiff: not a repo → "" for both baselines', async () => {
  const h = fakeHost(() => FAIL(-1, 'not a git repository'));
  assert.equal(await fileDiff(h.host, '/repo', 'a.ts', 'HEAD'), '');
  assert.equal(await fileDiff(h.host, '/repo', 'a.ts', 'Base'), '');
});

// ---- safe flags ----------------------------------------------------------

test('SAFE_GIT_FLAGS: global-safe options only (git rejects diff flags pre-subcommand)', () => {
  assert.deepEqual(SAFE_GIT_FLAGS(false), ['-c', 'core.fsmonitor=', '-c', 'core.hooksPath=/dev/null']);
  assert.deepEqual(SAFE_GIT_FLAGS(true), ['-c', 'core.fsmonitor=', '-c', 'core.hooksPath=NUL']);
});

test('SAFE_DIFF_FLAGS: diff-level hardening, inserted after the subcommand', () => {
  assert.deepEqual(SAFE_DIFF_FLAGS, ['--no-ext-diff', '--no-textconv']);
});

test('SAFE_GIT_ENV disables optional locks', () => {
  assert.deepEqual(SAFE_GIT_ENV, { GIT_OPTIONAL_LOCKS: '0' });
});

test('safeRun: prepends the safe flags and env around the raw runner', async () => {
  let seen: { args: string[]; env: Record<string, string> } | undefined;
  const r = await safeRun(
    async (args, env) => {
      seen = { args, env };
      return OK('ok');
    },
    ['status'],
    true,
  );
  assert.equal(r.stdout, 'ok');
  assert.deepEqual(seen!.args, [...SAFE_GIT_FLAGS(true), 'status']);
  assert.deepEqual(seen!.env, SAFE_GIT_ENV);
});

// ---- classifyNameStatus / parseNameStatus -------------------------------

test('classifyNameStatus: name-status letter mapping (git.rs parity)', () => {
  const cases: Array<[string, string | undefined]> = [
    ['A', 'Added'],
    ['D', 'Deleted'],
    ['M', 'Modified'],
    ['T', 'Modified'],
    ['R100', 'Modified'],
    ['C750', 'Modified'],
    ['U', undefined],
    ['', undefined],
  ];
  for (const [code, want] of cases) {
    assert.equal(classifyNameStatus(code), want, `classifyNameStatus(${JSON.stringify(code)})`);
  }
});

test('parseNameStatus: alternating code/path fields', () => {
  const map = parseNameStatus(z('M', 'src/a.ts', 'A', 'docs/new.md', 'D', 'old.md'));
  assert.equal(map.get('src/a.ts'), 'Modified');
  assert.equal(map.get('docs/new.md'), 'Added');
  assert.equal(map.get('old.md'), 'Deleted');
  assert.equal(map.size, 3);
});

test('parseNameStatus: rename is the code/old/new triple, keys the NEW path', () => {
  // Verified against `git diff --name-status -z --cached` on this machine:
  // R100<NUL>old<NUL>new<NUL>
  const map = parseNameStatus(z('R100', 'a.txt', 'b.txt', 'M', 'after.ts'));
  assert.equal(map.get('b.txt'), 'Modified', "rename's NEW path is keyed");
  assert.equal(map.has('a.txt'), false, "rename's old path is skipped");
  assert.equal(map.get('after.ts'), 'Modified', 'the record after the rename parses (no desync)');
  assert.equal(map.size, 2);
});

test('parseNameStatus: copy triple consumes old+new; trailing truncated field breaks', () => {
  assert.equal(parseNameStatus(z('C750', 'orig.txt', 'copy.txt')).get('copy.txt'), 'Modified');
  assert.equal(parseNameStatus(z('R100', 'old.txt')).size, 0, 'triple with missing new → stop');
});

test('parseNameStatus: unknown code letters are skipped; backslashes normalize', () => {
  const map = parseNameStatus(z('U', 'conflict.txt', 'M', 'src\\win.ts'));
  assert.equal(map.size, 1);
  assert.equal(map.get('src/win.ts'), 'Modified');
});

// ---- changedSet ----------------------------------------------------------

test('changedSet HEAD: exactly the working-tree status', async () => {
  const h = fakeHost((args) => (args[0] === 'status' ? OK(z(' M a.ts', '?? u.txt')) : FAIL()));
  const map = await changedSet(h.host, '/repo', 'HEAD');
  assert.equal(map.get('a.ts'), 'Modified');
  assert.equal(map.get('u.txt'), 'Untracked');
  assert.ok(h.calls.every((c) => c[0] === 'status'), 'HEAD path issues no diff');
});

test('changedSet Base: name-status vs fork-point, untracked merged in', async () => {
  const h = fakeHost((args) => {
    if (args[0] === 'symbolic-ref') return FAIL(1);
    if (args[0] === 'rev-parse') return args[2] === 'main' ? OK('main\n') : FAIL(1);
    if (args[0] === 'merge-base') return OK('FORK\n');
    if (args[0] === 'diff') return OK(z('M', 'committed.ts', 'A', 'branch-new.md'));
    if (args[0] === 'status') return OK(z('?? untracked.txt'));
    return FAIL();
  });
  const map = await changedSet(h.host, '/repo', 'Base');
  assert.equal(map.get('committed.ts'), 'Modified', 'committed-on-branch file carries a marker');
  assert.equal(map.get('branch-new.md'), 'Added');
  assert.equal(map.get('untracked.txt'), 'Untracked', 'untracked merged from status');
  assert.deepEqual(
    h.calls.find((c) => c[0] === 'diff'),
    ['diff', ...SAFE_DIFF_FLAGS, '--name-status', '-z', 'FORK'],
    'diff hardening flags present, fork-point as the revision',
  );
});

test('changedSet Base: merge-base failure diffs against the base branch itself', async () => {
  const h = fakeHost((args) => {
    if (args[0] === 'rev-parse') return args[2] === 'main' ? OK('main\n') : FAIL(1);
    if (args[0] === 'symbolic-ref') return FAIL(1);
    if (args[0] === 'merge-base') return FAIL(1, 'no merge base');
    if (args[0] === 'diff') return OK(z('M', 'x.ts'));
    if (args[0] === 'status') return OK('');
    return FAIL();
  });
  const map = await changedSet(h.host, '/repo', 'Base');
  assert.equal(map.get('x.ts'), 'Modified');
  assert.deepEqual(h.calls.find((c) => c[0] === 'diff'), [
    'diff',
    ...SAFE_DIFF_FLAGS,
    '--name-status',
    '-z',
    'main',
  ]);
});

test('changedSet Base: no base branch → degrades to HEAD status (fileDiff parity)', async () => {
  const h = fakeHost((args) => {
    if (args[0] === 'symbolic-ref' || args[0] === 'rev-parse') return FAIL(1);
    if (args[0] === 'status') return OK(z(' M a.ts'));
    return FAIL();
  });
  const map = await changedSet(h.host, '/repo', 'Base');
  assert.equal(map.get('a.ts'), 'Modified');
  assert.ok(!h.calls.some((c) => c[0] === 'diff'), 'no diff issued without a base');
});

test('changedSet: not a repo → empty map', async () => {
  const h = fakeHost(() => FAIL(-1, 'not a git repository'));
  assert.equal((await changedSet(h.host, '/repo', 'HEAD')).size, 0);
  assert.equal((await changedSet(h.host, '/repo', 'Base')).size, 0);
});

test('changedSet Base: an untracked path already in the diff is not overwritten', async () => {
  const h = fakeHost((args) => {
    if (args[0] === 'rev-parse') return args[2] === 'main' ? OK('main\n') : FAIL(1);
    if (args[0] === 'symbolic-ref') return FAIL(1);
    if (args[0] === 'merge-base') return OK('FORK\n');
    if (args[0] === 'diff') return OK(z('A', 'both.txt'));
    if (args[0] === 'status') return OK(z('?? both.txt'));
    return FAIL();
  });
  const map = await changedSet(h.host, '/repo', 'Base');
  assert.equal(map.get('both.txt'), 'Added', 'diff (committed) status wins over Untracked merge');
});

// ---- currentBranch / defaultBaseline -------------------------------------

test('currentBranch: branch name, undefined on detached HEAD / failure', async () => {
  assert.equal(await currentBranch(fakeHost(() => OK('feature/x\n')).host, '/repo'), 'feature/x');
  assert.equal(await currentBranch(fakeHost(() => OK('HEAD\n')).host, '/repo'), undefined);
  assert.equal(await currentBranch(fakeHost(() => FAIL(-1)).host, '/repo'), undefined);
});

test('defaultBaseline: Base on a branch other than the base branch (AC-14)', async () => {
  const h = fakeHost((args) => {
    if (args[0] === 'symbolic-ref') return OK('refs/remotes/origin/main\n');
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return OK('feature/x\n');
    return FAIL(1);
  });
  assert.equal(await defaultBaseline(h.host, '/repo'), 'Base');
});

test('defaultBaseline: HEAD on the base branch — origin/main ≡ main (AC-15)', async () => {
  const h = fakeHost((args) => {
    if (args[0] === 'symbolic-ref') return OK('refs/remotes/origin/main\n');
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return OK('main\n');
    return FAIL(1);
  });
  assert.equal(await defaultBaseline(h.host, '/repo'), 'HEAD');
});

test('defaultBaseline: no base branch or detached HEAD → HEAD', async () => {
  const noBase = fakeHost((args) =>
    args[0] === 'rev-parse' && args[1] === '--abbrev-ref' ? OK('main\n') : FAIL(1),
  );
  assert.equal(await defaultBaseline(noBase.host, '/repo'), 'HEAD');
  const detached = fakeHost((args) => {
    if (args[0] === 'symbolic-ref') return OK('refs/remotes/origin/main\n');
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return OK('HEAD\n');
    return FAIL(1);
  });
  assert.equal(await defaultBaseline(detached.host, '/repo'), 'HEAD');
});
