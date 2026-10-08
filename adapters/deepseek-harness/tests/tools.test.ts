import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFileDiffText,
  buildFileTreeText,
  buildSearchText,
  createContentSearchTool,
  createFileDiffTool,
  createFileTreeTool,
} from '../src/tools.ts';
import { fakeHost, porcelain, OK, FAIL, type FakeHostOptions } from './helpers.ts';

/** A minimal repo fixture: rev-parse/status/diff answers for `/ws`. */
function repoGit(overrides: Partial<Record<string, (args: string[]) => ReturnType<typeof OK>>> = {}) {
  return (args: string[], _dir: string) => {
    const [cmd, ...rest] = args;
    if (cmd === 'rev-parse' && rest[0] === '--show-toplevel') return OK('/ws\n');
    if (cmd === 'rev-parse' && rest[0] === '--is-inside-work-tree') return OK('true\n');
    if (cmd === 'rev-parse' && rest[0] === '--verify') return FAIL(1, 'unknown revision');
    if (cmd === 'symbolic-ref') return FAIL(1, 'not a symbolic ref');
    if (cmd === 'merge-base') return FAIL(1, 'no merge base');
    if (cmd === 'status') return OK('');
    if (cmd === 'diff') return OK('');
    const custom = overrides[cmd!];
    if (custom) return custom(rest);
    return FAIL(128, `unexpected git ${cmd}`);
  };
}

const FILES = {
  'src/index.ts': "export const apply = () => 1\n// needle line\n",
  'src/core/tree.ts': 'export const rows: never[] = []\n',
  'README.md': '# demo\n',
  'node_modules/pkg/index.js': '// heavy\n// needle in node_modules\n',
};

const TREE_FILES = {
  ...FILES,
  'docs/guide.md': 'guide\n',
  'docs/api/ref.md': 'ref\n',
};

test('buildFileTreeText: nested rows, markers, no node_modules descent', async () => {
  const host = fakeHost(FILES, {
    git: (args) => {
      const base = repoGit();
      if (args[0] === 'status') return OK(porcelain(' M src/index.ts', '?? README.md'));
      return base(args, '');
    },
  });
  const text = await buildFileTreeText(host, '/ws', {});
  assert.ok(text.includes('src/'));
  assert.ok(text.includes('index.ts [M]'));
  assert.ok(text.includes('README.md [?]'));
  // node_modules itself is listed as a dir but never descended into
  assert.ok(text.includes('node_modules/'));
  assert.ok(!text.includes('node_modules/pkg'));
  assert.ok(text.includes('[M] modified'));
});

test('buildFileTreeText: max_depth bounds descent', async () => {
  const host = fakeHost(TREE_FILES, { git: repoGit() });
  const text = await buildFileTreeText(host, '/ws', { max_depth: 1 });
  assert.ok(text.includes('src/'));
  assert.ok(!text.includes('index.ts'), 'depth 1 must not show src children');
  assert.ok(text.includes('not a git repository') === false || text.includes('(git:'));
});

test('buildFileTreeText: changed_only synthesizes rows from status only', async () => {
  const host = fakeHost(FILES, {
    git: (args) => {
      if (args[0] === 'status') return OK(porcelain('?? new-dir/added.txt'));
      return repoGit()(args, '');
    },
  });
  const text = await buildFileTreeText(host, '/ws', { changed_only: true });
  assert.ok(text.includes('new-dir/'));
  assert.ok(text.includes('added.txt [?]'));
  assert.ok(!text.includes('README.md'), 'unchanged files stay out of changed-only trees');
});

test('buildFileTreeText: clean repo notes the clean tree', async () => {
  const host = fakeHost(FILES, { git: repoGit() });
  const text = await buildFileTreeText(host, '/ws', {});
  assert.ok(text.includes('(git: working tree clean'));
});

test('buildFileTreeText: missing path reports not found', async () => {
  const host = fakeHost(FILES, { git: repoGit() });
  const text = await buildFileTreeText(host, '/ws', { path: 'nope' });
  assert.ok(text.includes('(path not found: nope)'));
});

test('buildFileDiffText: HEAD baseline diff passes through', async () => {
  const diff =
    'diff --git a/src/index.ts b/src/index.ts\n' +
    '--- a/src/index.ts\n' +
    '+++ b/src/index.ts\n' +
    '@@ -1 +1 @@\n' +
    '-export const apply = 0\n' +
    '+export const apply = 1\n';
  const host = fakeHost(FILES, {
    git: (args) => {
      if (args[0] === 'status') return OK(porcelain(' M src/index.ts'));
      if (args[0] === 'diff' && args.includes('HEAD')) {
        assert.ok(args.includes('--no-ext-diff') && args.includes('--no-textconv'));
        return OK(diff);
      }
      return repoGit()(args, '');
    },
  });
  const text = await buildFileDiffText(host, '/ws', { path: 'src/index.ts' });
  assert.ok(text.startsWith('# diff src/index.ts vs HEAD\n'));
  assert.ok(text.includes('@@ -1 +1 @@'));
  assert.ok(text.includes('+export const apply = 1'));
});

test('buildFileDiffText: untracked file becomes a whole-file add', async () => {
  const host = fakeHost(
    { ...FILES, 'fresh.txt': 'hello\n' },
    {
      git: (args) => {
        if (args[0] === 'status') return OK(porcelain('?? fresh.txt'));
        if (args[0] === 'diff' && args.includes('--no-index')) {
          assert.ok(args.includes('/dev/null'), 'null device expected on POSIX fake host');
          // git diff --no-index exits 1 when files differ — stdout still carries the diff.
          return {
            exitCode: 1,
            stdout:
              'diff --git a/NUL b/fresh.txt\n--- /dev/null\n+++ b/fresh.txt\n@@ -0,0 +1 @@\n+hello\n',
            stderr: '',
          };
        }
        return repoGit()(args, '');
      },
    },
  );
  const text = await buildFileDiffText(host, '/ws', { path: 'fresh.txt', full_context: true });
  assert.ok(text.includes('diff --git a/fresh.txt b/fresh.txt'));
  assert.ok(text.includes('--- /dev/null'));
  assert.ok(text.includes('+++ b/fresh.txt'));
});

test('buildFileDiffText: Base falls back to HEAD without a base branch', async () => {
  const host = fakeHost(FILES, { git: repoGit() });
  const text = await buildFileDiffText(host, '/ws', { path: 'README.md', baseline: 'Base' });
  // no origin/HEAD, no origin/main/master → fileDiff falls back to HEAD → clean
  assert.ok(text.includes('vs HEAD'));
  assert.ok(text.includes('(no differences)'));
});

test('buildFileDiffText: not a repo degrades with a note', async () => {
  const host = fakeHost(FILES, { git: () => FAIL(128, 'not a git repository') });
  const text = await buildFileDiffText(host, '/ws', { path: 'README.md' });
  assert.ok(text.includes('not a git repository'));
});

test('buildSearchText: path:line rows, node_modules/hidden skipped, limit note', async () => {
  const host = fakeHost(
    {
      ...FILES,
      '.hidden/secret.ts': '// needle hidden\n',
      'src/second.ts': 'NEEDLE upper\n',
    },
    { git: repoGit() },
  );
  const text = await buildSearchText(host, '/ws', { query: 'needle', limit: 1 });
  assert.ok(text.includes('src/index.ts:2:'), text);
  assert.ok(!text.includes('node_modules'));
  assert.ok(!text.includes('.hidden'));
  assert.ok(text.includes('truncated at limit=1'));

  const all = await buildSearchText(host, '/ws', { query: 'needle' });
  assert.ok(all.includes('src/second.ts'), 'case-insensitive match expected');
  assert.ok(!all.includes('truncated at limit'));
});

test('tool definitions: names, execute wiring, and text render', async () => {
  const host = fakeHost(FILES, { git: repoGit() });
  const deps = { host, processCwd: () => '/ws' };
  const exec = { agent: { session: { header: { cwd: '/ws' } } } } as never;

  const treeTool = createFileTreeTool(deps);
  const diffTool = createFileDiffTool(deps);
  const searchTool = createContentSearchTool(deps);
  assert.equal(treeTool.name, 'file_tree');
  assert.equal(diffTool.name, 'file_diff');
  assert.equal(searchTool.name, 'content_search');

  const treeValue = (await treeTool.execute({}, exec)) as string;
  assert.ok(treeValue.includes('# file tree'));
  const diffValue = (await diffTool.execute({ path: 'README.md' }, exec)) as string;
  assert.ok(diffValue.startsWith('# diff README.md'));
  const searchValue = (await searchTool.execute({ query: 'needle' }, exec)) as string;
  assert.ok(searchValue.includes('match(es)'));

  const blocks = treeTool.output.render({} as never, treeValue);
  assert.deepEqual(blocks, [{ type: 'text', text: treeValue }]);

  // session cwd drives the workspace even when process.cwd differs
  const foreign = createFileTreeTool({ host, processCwd: () => '/somewhere-else' });
  const value = (await foreign.execute({ path: 'src' }, exec)) as string;
  assert.ok(value.includes('index.ts'));
});

test('tool execute falls back to process.cwd without an agent', async () => {
  const host = fakeHost(FILES, { git: repoGit() });
  const tool = createFileTreeTool({ host, processCwd: () => '/ws' });
  const value = (await tool.execute({}, { signal: new AbortController().signal } as never)) as string;
  assert.ok(value.includes('src/'));
});

const _typecheck: FakeHostOptions | undefined = undefined;
void _typecheck;
