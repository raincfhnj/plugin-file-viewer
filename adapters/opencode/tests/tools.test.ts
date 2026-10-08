/**
 * Unit tests for the four OpenCode tool bodies, with a fake Host (in-memory
 * files + scripted git). The loader's export rules only apply to plugin.ts's
 * entry module, so test files may export whatever they like.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DirEntry, GitStatus, Host, RunResult, TreeNode } from '../core/types.ts';
import {
  contentSearch,
  fileDiff,
  fileSearch,
  fileTree,
  fit,
  rowLabel,
  toRel,
  OUTPUT_LIMIT,
  type RepoContext,
} from '../tools.ts';

const NUL = String.fromCharCode(0);
const ROOT = 'D:/repo';

type GitStub = (args: string[]) => RunResult;

const ok = (stdout: string): RunResult => ({ exitCode: 0, stdout, stderr: '' });
const fail = (stderr = 'git failed'): RunResult => ({ exitCode: 128, stdout: '', stderr });

/** `git status --porcelain=v1 -z` payload from XY-path strings like ' M a.ts'. */
function porcelain(entries: string[]): string {
  return entries.map((e) => e + NUL).join('');
}

function makeRepo(files: Record<string, string>, git?: GitStub): RepoContext {
  const host: Host = {
    cwd: () => ROOT,
    isWindows: true,
    async listDir(relPath: string): Promise<DirEntry[]> {
      const dir = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
      const prefix = dir === '' ? '' : dir + '/';
      const found = new Map<string, 'dir' | 'file'>();
      for (const p of Object.keys(files)) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        if (rest === '') continue;
        const at = rest.indexOf('/');
        if (at === -1) found.set(rest, 'file');
        else found.set(rest.slice(0, at), 'dir');
      }
      const out: DirEntry[] = [];
      for (const [name, kind] of found) {
        out.push(kind === 'dir' ? { name, kind } : { name, kind, size: files[`${prefix}${name}`]!.length });
      }
      return out;
    },
    async readText(relPath: string): Promise<string> {
      const p = relPath.replace(/\\/g, '/');
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p]!;
    },
    async exists(relPath: string): Promise<boolean> {
      const p = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
      if (p === '' || p === '.') return true;
      if (p in files) return true;
      const prefix = p + '/';
      return Object.keys(files).some((k) => k.startsWith(prefix));
    },
    async runGit(_dir: string, args: string[]): Promise<RunResult> {
      return git ? git(args) : fail('not a git repository');
    },
  };
  return { host, root: ROOT, git: git !== undefined };
}

const FIXTURE: Record<string, string> = {
  'README.md': '# hi\n',
  'docs/guide.md': 'guide\n',
  'src/app.ts': 'export const a = 1;\n',
  'src/deep/util.ts': 'export const u = 1;\n',
};

const STATUS_CHANGED = [' M README.md', ' M src/app.ts'];

function lines(output: string): string[] {
  return output.split('\n');
}

// --- rowLabel (must stay byte-compatible with claude-code's pane.ts) -----------

const file = (path: string, depth: number, status?: GitStatus): TreeNode => ({
  path,
  kind: 'file',
  depth,
  expanded: false,
  status,
  dirDirty: false,
});
const dir = (path: string, depth: number, expanded: boolean, dirDirty = false): TreeNode => ({
  path,
  kind: 'dir',
  depth,
  expanded,
  dirDirty,
});

test('rowLabel matches the pane format (mark, indent, caret, dirDirty)', () => {
  assert.equal(rowLabel(file('src/a.ts', 1, 'Modified')), '  M   a.ts');
  assert.equal(rowLabel(file('README.md', 0)), '    README.md');
  assert.equal(rowLabel(file('new.ts', 0, 'Untracked')), '  ? new.ts');
  assert.equal(rowLabel(file('gone.ts', 0, 'Deleted')), '  D gone.ts');
  assert.equal(rowLabel(file('added.ts', 0, 'Added')), '  A added.ts');
  assert.equal(rowLabel(dir('src', 0, false)), '    ▸ src');
  assert.equal(rowLabel(dir('src', 0, true)), '    ▾ src');
  assert.equal(rowLabel(dir('assets', 0, true, true)), '    ▾ assets~');
  assert.equal(rowLabel(dir('deep', 1, false)), '      ▸ deep');
});

test('toRel normalizes separators and strips the root prefix', () => {
  assert.equal(toRel(ROOT, ''), '');
  assert.equal(toRel(ROOT, 'src\\a.ts'), 'src/a.ts');
  assert.equal(toRel(ROOT, './src'), 'src');
  assert.equal(toRel(ROOT, 'D:/repo/src/x.ts'), 'src/x.ts');
  assert.equal(toRel(ROOT, 'D:/other/x.ts'), 'D:/other/x.ts');
});

test('fit truncates at the output cap with an explicit note', () => {
  const big = 'x'.repeat(OUTPUT_LIMIT + 5000);
  const cut = fit(big);
  assert.equal(cut.length, OUTPUT_LIMIT);
  assert.match(cut, /truncated: kept \d+ of \d+ chars/);
  assert.equal(fit('short'), 'short');
});

// --- file_tree -----------------------------------------------------------------

test('file_tree depth=1 renders top-level rows with git marks and dirDirty', async () => {
  const repo = makeRepo(FIXTURE, (args) =>
    args[0] === 'status' ? ok(porcelain(STATUS_CHANGED)) : fail(),
  );
  const res = await fileTree(repo, { depth: 1 });
  assert.equal(res.title, 'file_tree . (3 rows)');
  assert.deepEqual(lines(res.output), [
    '# file_tree path=. git=yes depth=1 rows=3',
    '# marks: M modified  A added  D deleted  ? untracked  ~ dir has changes',
    '    ▸ docs',
    '    ▸ src~',
    '  M README.md',
  ]);
});

test('file_tree depth=2 expands one more level', async () => {
  const repo = makeRepo(FIXTURE, (args) =>
    args[0] === 'status' ? ok(porcelain(STATUS_CHANGED)) : fail(),
  );
  const res = await fileTree(repo, { depth: 2 });
  assert.deepEqual(lines(res.output), [
    '# file_tree path=. git=yes depth=2 rows=6',
    '# marks: M modified  A added  D deleted  ? untracked  ~ dir has changes',
    '    ▾ docs',
    '      guide.md',
    '    ▾ src~',
    '      ▸ deep',
    '  M   app.ts',
    '  M README.md',
  ]);
});

test('file_tree changed_only synthesizes rows from the status map', async () => {
  const repo = makeRepo(FIXTURE, (args) =>
    args[0] === 'status' ? ok(porcelain(STATUS_CHANGED)) : fail(),
  );
  const res = await fileTree(repo, { changedOnly: true });
  assert.deepEqual(lines(res.output), [
    '# file_tree path=. git=yes depth=3 rows=3',
    '# marks: M modified  A added  D deleted  ? untracked  ~ dir has changes',
    '    ▾ src~',
    '  M   app.ts',
    '  M README.md',
  ]);
});

test('file_tree: unknown path, non-git changed_only, and clean repo', async () => {
  const missing = await fileTree(makeRepo(FIXTURE), { path: 'nope' });
  assert.match(missing.output, /path not found: nope/);

  const noGit = await fileTree(makeRepo(FIXTURE), { changedOnly: true });
  assert.match(noGit.output, /changed_only needs a git repository/);

  const clean = await fileTree(makeRepo(FIXTURE, () => ok('')), { changedOnly: true });
  assert.match(clean.output, /\(no changed files\)/);

  const plain = await fileTree(makeRepo(FIXTURE), {});
  assert.deepEqual(lines(plain.output), [
    '# file_tree path=. git=no depth=3 rows=7',
    '    ▾ docs',
    '      guide.md',
    '    ▾ src',
    '      ▾ deep',
    '        util.ts',
    '      app.ts',
    '    README.md',
  ]);
});

// --- file_diff -----------------------------------------------------------------

interface DiffSpec {
  status?: string[];
  headDiff?: string;
  baseDiff?: string;
  noIndexDiff?: string;
  seen?: string[][];
}

function diffGit(spec: DiffSpec): GitStub {
  return (args: string[]): RunResult => {
    spec.seen?.push([...args]);
    const cmd = args[0];
    if (cmd === 'status') return ok(porcelain(spec.status ?? []));
    if (cmd === 'symbolic-ref') return fail('no remote HEAD');
    if (cmd === 'merge-base') return ok('abc123\n');
    if (cmd === 'rev-parse') {
      const candidate = args[args.length - 1] ?? '';
      return candidate === 'main' ? ok('main\n') : fail('unknown revision');
    }
    if (cmd === 'diff') {
      if (args.includes('--no-index')) return ok(spec.noIndexDiff ?? '');
      if (args.includes('HEAD')) return ok(spec.headDiff ?? '');
      if (args.includes('abc123')) return ok(spec.baseDiff ?? '');
      return fail('diff failed');
    }
    return fail();
  };
}

const HEAD_DIFF =
  'diff --git a/src/app.ts b/src/app.ts\n' +
  '--- a/src/app.ts\n' +
  '+++ b/src/app.ts\n' +
  '@@ -1 +1 @@\n' +
  '-export const a = 1;\n' +
  '+export const a = 2;\n';

test('file_diff baseline=HEAD returns the unified diff plus view hint', async () => {
  const seen: string[][] = [];
  const repo = makeRepo(FIXTURE, diffGit({ status: [' M src/app.ts'], headDiff: HEAD_DIFF, seen }));
  const res = await fileDiff(repo, { path: 'src/app.ts' });
  const out = lines(res.output);
  assert.equal(
    out[0],
    '# file_diff src/app.ts baseline=HEAD git=yes view=diff modes=diff, fullDiff, syntaxContent',
  );
  assert.equal(out.slice(1).join('\n'), HEAD_DIFF);
  // head path: git diff HEAD -- path, safety flags carried by Host.runGit
  const diffArgs = seen.find((a) => a[0] === 'diff' && a.includes('HEAD'));
  assert.ok(diffArgs);
  assert.deepEqual(diffArgs.slice(0, 3), ['diff', '--no-ext-diff', '--no-textconv']);
  assert.equal(diffArgs[diffArgs.length - 1], 'src/app.ts');
});

test('file_diff baseline=Base diffs against the merge-base of the default base branch', async () => {
  const seen: string[][] = [];
  const repo = makeRepo(
    FIXTURE,
    diffGit({ status: [' M src/app.ts'], baseDiff: 'diff --git a/src/app.ts b/src/app.ts\n+base\n', seen }),
  );
  const res = await fileDiff(repo, { path: 'src/app.ts', baseline: 'Base' });
  assert.match(res.output, /^# file_diff src\/app\.ts baseline=Base git=yes view=diff/);
  assert.match(res.output, /\+base\n$/);
  assert.ok(seen.some((a) => a[0] === 'merge-base'));
  assert.ok(seen.some((a) => a[0] === 'diff' && a.includes('abc123')));
});

test('file_diff full=true asks for full context', async () => {
  const seen: string[][] = [];
  const repo = makeRepo(FIXTURE, diffGit({ status: [' M src/app.ts'], headDiff: HEAD_DIFF, seen }));
  await fileDiff(repo, { path: 'src/app.ts', full: true });
  assert.ok(seen.some((a) => a[0] === 'diff' && a.includes('-U1000000')));
});

test('file_diff untracked file renders as an add (null-device headers rewritten)', async () => {
  const repo = makeRepo(
    { ...FIXTURE, 'new.txt': 'hello\n' },
    diffGit({
      status: ['?? new.txt'],
      noIndexDiff:
        'diff --git a/NUL b/new.txt\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hello\n',
    }),
  );
  const res = await fileDiff(repo, { path: 'new.txt' });
  assert.match(res.output, /diff --git a\/new\.txt b\/new\.txt/);
  assert.match(res.output, /^\+\+\+ b\/new\.txt$/m);
  assert.doesNotMatch(res.output, /a\/NUL/);
  assert.match(res.output, /view=diff/); // untracked → changed → diff view
});

test('file_diff: no changes, missing path, deleted file, clean markdown hint', async () => {
  const empty = await fileDiff(makeRepo(FIXTURE, diffGit({})), { path: 'src/app.ts' });
  assert.match(empty.output, /\(no changes against HEAD\)/);

  const missing = await fileDiff(makeRepo(FIXTURE, diffGit({})), { path: 'ghost.ts' });
  assert.match(missing.output, /path not found: ghost\.ts/);

  const deleted = await fileDiff(
    makeRepo(FIXTURE, diffGit({ status: [' D src/deep/util.ts'], headDiff: 'diff --git a/src/deep/util.ts b/src/deep/util.ts\ndeleted file mode 100644\n' })),
    { path: 'src/deep/util.ts' },
  );
  assert.match(deleted.output, /^# file_diff src\/deep\/util\.ts baseline=HEAD git=yes view=diff/);
  assert.match(deleted.output, /deleted file mode/);

  const cleanMd = await fileDiff(makeRepo(FIXTURE, diffGit({})), { path: 'README.md' });
  assert.match(cleanMd.output, /view=renderedMarkdown modes=renderedMarkdown, syntaxContent/);
});

// --- file_search ---------------------------------------------------------------

test('file_search ranks basename hits above directory-only hits', async () => {
  const repo = makeRepo({
    'src/tool/x.ts': 'x',
    'x/tool.ts': 'y',
    'README.md': 'z',
  });
  const res = await fileSearch(repo, { query: 'tool' });
  const body = lines(res.output).slice(1);
  assert.equal(body.length, 2);
  assert.match(body[0]!, /^-?\d+  x\/tool\.ts$/);
  assert.match(body[1]!, /^-?\d+  src\/tool\/x\.ts$/);
  assert.match(lines(res.output)[0]!, /hits=2 scanned=3/);

  const empty = await fileSearch(repo, { query: '   ' });
  assert.match(empty.output, /empty query/);

  const none = await fileSearch(repo, { query: 'zzzzqqq' });
  assert.match(none.output, /\(no matches\)/);
});

// --- content_search ------------------------------------------------------------

test('content_search returns path:line rows and skips hidden/binary/non-text', async () => {
  const repo = makeRepo({
    'src/a.ts': 'line one\nHello World\nthird\n',
    'src/b.ts': 'say hello again\n',
    'node_modules/pkg/index.js': 'hello from dep\n',
    '.env': 'hello=1\n',
    'logo.png': 'hello bytes\n',
  });
  const res = await contentSearch(repo, { query: 'hello' });
  assert.deepEqual(lines(res.output), [
    '# content_search "hello" matches=2 limit=100',
    'src/a.ts:2: Hello World',
    'src/b.ts:1: say hello again',
  ]);

  const limited = await contentSearch(repo, { query: 'hello', limit: 1 });
  assert.match(limited.output, /matches=1 limit=1/);
  assert.doesNotMatch(limited.output, /src\/b\.ts/);

  const none = await contentSearch(repo, { query: 'nothing-matches-this' });
  assert.match(none.output, /\(no matches\)/);
});
