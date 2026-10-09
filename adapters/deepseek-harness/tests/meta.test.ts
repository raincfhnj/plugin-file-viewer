/**
 * Sidebar metadata: line grammar, session-address gating, and the tool
 * value → render/presentationMeta projection that feeds the browser half.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendSidebarMeta,
  fileViewerMetaOf,
  parseSidebarMeta,
  sessionFileAddress,
  stripSidebarMeta,
} from '../src/meta.ts';
import {
  buildFileDiffText,
  buildFileTreeText,
  buildSearchText,
  createContentSearchTool,
  createFileDiffTool,
  createFileTreeTool,
} from '../src/tools.ts';
import { fakeHost, porcelain, OK, FAIL } from './helpers.ts';

const ADDR = 'dsh-resource://file/session/sess-1/src/index.ts';

test('append/strip/parse roundtrip of the sidebar line grammar', () => {
  const text = appendSidebarMeta('body\n', { address: ADDR, line: 42 });
  assert.ok(text.includes(`sidebar address: ${ADDR}`));
  assert.ok(text.includes('sidebar line: 42'));
  assert.deepEqual(parseSidebarMeta(text), { address: ADDR, line: 42 });
  assert.equal(stripSidebarMeta(text), 'body');

  const tabbed = appendSidebarMeta('# file tree\n', { tab: 'files' });
  assert.deepEqual(parseSidebarMeta(tabbed), { tab: 'files' });
  assert.equal(stripSidebarMeta(tabbed), '# file tree');

  // Plain text is untouched; non-positive/non-integer lines are dropped.
  assert.equal(stripSidebarMeta('plain\nsidebar address'), 'plain\nsidebar address');
  assert.equal(appendSidebarMeta('x', { line: 0 }), 'x');
  assert.deepEqual(parseSidebarMeta('sidebar line: 1.5'), {});
});

test('fileViewerMetaOf: address lines win, tree title maps to the files tab', () => {
  assert.deepEqual(fileViewerMetaOf(`diff text\nsidebar address: ${ADDR}`), {
    fileViewer: { address: ADDR },
  });
  assert.deepEqual(fileViewerMetaOf('# file tree — root "." of /ws\nrow'), {
    fileViewer: { tab: 'files' },
  });
  assert.deepEqual(fileViewerMetaOf('no metadata here'), {});
});

test('sessionFileAddress: session scope only, rooted like /files', () => {
  // Relative tool path rooted at the git root, relativized against the cwd.
  assert.equal(
    sessionFileAddress('sess-1', '/ws', '/ws', 'src/index.ts'),
    ADDR,
  );
  // Repo nested inside the session cwd: joined then relativized.
  assert.equal(
    sessionFileAddress('sess-1', '/ws', '/ws/sub/repo', 'src/a.ts'),
    'dsh-resource://file/session/sess-1/sub/repo/src/a.ts',
  );
  // Absolute input inside the cwd.
  assert.equal(
    sessionFileAddress('sess-1', '/ws', '/ws', '/ws/src/index.ts'),
    ADDR,
  );
  // Unknown session / outside the cwd / reported-missing → nothing to open.
  assert.equal(sessionFileAddress(undefined, '/ws', '/ws', 'src/index.ts'), undefined);
  assert.equal(sessionFileAddress('sess-1', '/ws', '/ws', '/other/x.ts'), undefined);
  // Repo root ABOVE the cwd: the target is outside the session workspace, and
  // the shipped file provider rejects non-session addresses — nothing to open.
  assert.equal(sessionFileAddress('sess-1', '/ws', '/repo', 'src/a.ts'), undefined);
  assert.equal(
    sessionFileAddress('sess-1', '/ws', '/ws', 'src/gone.ts', '(path not found: src/gone.ts)'),
    undefined,
  );
});

/** Scripted git: repo rooted at /ws with a clean status. */
function repoGit() {
  return (args: string[]): ReturnType<typeof OK> => {
    const [cmd, ...rest] = args;
    if (cmd === 'rev-parse' && rest[0] === '--show-toplevel') return OK('/ws\n');
    if (cmd === 'rev-parse' && rest[0] === '--is-inside-work-tree') return OK('true\n');
    if (cmd === 'rev-parse' && rest[0] === '--verify') return FAIL(1, 'unknown revision');
    if (cmd === 'symbolic-ref') return FAIL(1, 'not a symbolic ref');
    if (cmd === 'merge-base') return FAIL(1, 'no merge base');
    if (cmd === 'status') return OK('');
    if (cmd === 'diff') return OK('');
    return FAIL(128, `unexpected git ${cmd}`);
  };
}

const FILES = {
  'src/index.ts': 'export const a = 1\n// needle line\n',
  'README.md': '# demo\n',
};

const EXEC = {
  agent: { id: 'sess-1', session: { header: { cwd: '/ws' } } },
} as never;

test('file_diff: execute appends the address, render strips it, meta projects it', async () => {
  const host = fakeHost(
    { ...FILES, 'src/index.ts': 'old\nnew\n' },
    {
      git: (args) => {
        if (args[0] === 'status') return OK(porcelain(' M src/index.ts'));
        if (args[0] === 'diff') return OK('');
        return repoGit()(args);
      },
    },
  );
  const tool = createFileDiffTool({ host, processCwd: () => '/somewhere' });
  const value = (await tool.execute({ path: 'src/index.ts' }, EXEC)) as string;

  assert.ok(value.startsWith('# diff src/index.ts vs HEAD'), value.slice(0, 80));
  assert.ok(value.includes(`sidebar address: ${ADDR}`), value);

  const blocks = tool.output.render({} as never, value);
  assert.equal(blocks.length, 1);
  const text = (blocks[0] as { text: string }).text;
  assert.ok(!text.includes('sidebar address'), 'model content must not see the metadata');
  assert.ok(text.startsWith('# diff src/index.ts vs HEAD'));

  assert.deepEqual(tool.output.presentationMeta!({} as never, value), {
    fileViewer: { address: ADDR },
  });
});

test('file_diff without a session id emits no metadata (old contract intact)', async () => {
  const host = fakeHost(FILES, { git: repoGit() });
  const tool = createFileDiffTool({ host, processCwd: () => '/ws' });
  const exec = { agent: { session: { header: { cwd: '/ws' } } } } as never;
  const value = (await tool.execute({ path: 'README.md' }, exec)) as string;
  assert.ok(!value.includes('sidebar address'));
  assert.deepEqual(tool.output.presentationMeta!({} as never, value), {});
});

test('content_search: first match carries address + params.line', async () => {
  const host = fakeHost(FILES, { git: repoGit() });
  const tool = createContentSearchTool({ host, processCwd: () => '/ws' });
  const value = (await tool.execute({ query: 'needle' }, EXEC)) as string;

  assert.ok(value.includes('src/index.ts:2:'), value);
  assert.ok(value.includes(`sidebar address: ${ADDR}`), value);
  assert.ok(value.includes('sidebar line: 2'), value);
  assert.deepEqual(tool.output.presentationMeta!({} as never, value), {
    fileViewer: { address: ADDR, line: 2 },
  });
  const text = (tool.output.render({} as never, value)[0] as { text: string }).text;
  assert.ok(!text.includes('sidebar '));
});

test('file_tree: canonical value stays pure; meta maps to the files tab', async () => {
  const host = fakeHost(FILES, { git: repoGit() });
  const tool = createFileTreeTool({ host, processCwd: () => '/ws' });
  const value = (await tool.execute({}, EXEC)) as string;

  assert.ok(value.startsWith('# file tree'), value.slice(0, 80));
  assert.ok(!value.includes('sidebar '), 'tree value carries no appended lines');
  assert.deepEqual(tool.output.presentationMeta!({} as never, value), {
    fileViewer: { tab: 'files' },
  });
  assert.deepEqual(tool.output.render({} as never, value), [{ type: 'text', text: value }]);
});

test('build helpers accept an optional sessionId (tests without one stay valid)', async () => {
  const host = fakeHost(FILES, { git: repoGit() });
  const without = await buildFileDiffText(host, '/ws', { path: 'README.md' });
  assert.ok(!without.includes('sidebar address'));
  const withSid = await buildFileDiffText(host, '/ws', { path: 'README.md' }, 'sess-1');
  assert.ok(withSid.includes('sidebar address: dsh-resource://file/session/sess-1/README.md'));
  const search = await buildSearchText(host, '/ws', { query: 'needle' }, 'sess-1');
  assert.ok(search.includes('sidebar line: 2'));
  const tree = await buildFileTreeText(host, '/ws', {});
  assert.ok(!tree.includes('sidebar '));
});
