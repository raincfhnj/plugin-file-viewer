/**
 * Smoke suite (3-5 key cases): fake cordis ctx registration, tool output
 * formats, `path:line` parsing, and the degraded `/files` handler text.
 * Run: node --test "adapters/deepseek-harness/tests/*.test.ts"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/index.ts';
import { createContentSearchTool } from '../src/tools.ts';
import { createFilesCommand } from '../src/files-command.ts';
import { parseFileRef, type RunResult } from '../src/core/types.ts';
import { fakeHost, porcelain, OK, FAIL } from './helpers.ts';

/** Minimal cordis-shaped ctx that captures registrations. */
function fakeCtx() {
  const tools: Array<{ name: string; description: string; output: { render: unknown } }> = [];
  const commands: Array<{
    name: string;
    description: string;
    input: { hint: string };
    handler: (invocation: never) => unknown;
  }> = [];
  const ctx = {
    effect(fn: () => unknown) {
      fn();
      return () => {};
    },
    tools: {
      register(tool: (typeof tools)[number]) {
        tools.push(tool);
        return () => {};
      },
    },
    commands: {
      register(command: (typeof commands)[number]) {
        commands.push(command);
        return () => {};
      },
    },
    get() {
      return undefined;
    },
  };
  return { ctx, tools, commands };
}

test('smoke: apply() registers 3 tools + /files with render contract', () => {
  const { ctx, tools, commands } = fakeCtx();
  apply(ctx as never);

  assert.deepEqual(
    tools.map((t) => t.name),
    ['file_tree', 'file_diff', 'content_search'],
  );
  for (const tool of tools) assert.ok(tool.description.length > 20, tool.name);

  assert.equal(commands.length, 1);
  assert.equal(commands[0]!.name, 'files');
  assert.equal(commands[0]!.input.hint, 'path[:line]');

  const render = tools[0]!.output.render as (_a: unknown, v: string) => unknown;
  assert.deepEqual(render({}, 'hello'), [{ type: 'text', text: 'hello' }]);
});

test('smoke: file_tree executes against the real Node host from process.cwd', async () => {
  const { ctx, tools } = fakeCtx();
  apply(ctx as never);
  const tool = tools[0] as unknown as {
    execute(args: object, exec: unknown): Promise<string>;
  };

  const text = await tool.execute({}, { signal: new AbortController().signal });
  assert.ok(text.startsWith('# file tree — root "'), text.slice(0, 120));
  assert.ok(
    /(\(not a git repository|\(git:|\[M\] modified|\[\?\] untracked)/.test(text),
    'git awareness (note or markers) expected',
  );
  assert.ok(text.split('\n').length > 3, 'tree must list rows');
});

test('smoke: content_search emits path:line rows with a limit note', async () => {
  const host = fakeHost({
    'src/a.ts': 'const needle = 1\n',
    'src/b.ts': 'NEEDLE here\nother\n',
  });
  const tool = createContentSearchTool({ host, processCwd: () => '/ws' });
  const exec = { agent: { session: { header: { cwd: '/ws' } } } } as never;

  const text = (await tool.execute({ query: 'needle' }, exec)) as string;
  assert.ok(text.startsWith('2 match(es) for "needle"'), text);
  assert.ok(text.includes('src/a.ts:1: const needle = 1'), text);
  assert.ok(text.includes('src/b.ts:1: NEEDLE here'), text);

  const capped = (await tool.execute({ query: 'needle', limit: 1 }, exec)) as string;
  assert.ok(capped.includes('truncated at limit=1'), capped);
});

test('smoke: parseFileRef handles path:line, bare paths, drive letters', () => {
  assert.deepEqual(parseFileRef('src/app.ts:42'), { path: 'src/app.ts', line: 42 });
  assert.deepEqual(parseFileRef('src/app.ts'), { path: 'src/app.ts' });
  assert.deepEqual(parseFileRef('C:/x/y.txt:7'), { path: 'C:/x/y.txt', line: 7 });
  assert.deepEqual(parseFileRef('  src/a.ts:9  '), { path: 'src/a.ts', line: 9 });
});

test('smoke: /files degrades to file info + dsh-resource address (no sidebar)', async () => {
  const git = (args: string[]): RunResult => {
    const [cmd, ...rest] = args;
    if (cmd === 'rev-parse' && rest[0] === '--show-toplevel') return OK('/ws\n');
    if (cmd === 'status') return OK(porcelain(' M src/index.ts'));
    return FAIL(1, `unexpected git ${cmd}`);
  };
  const host = fakeHost(
    { '/ws/src/index.ts': 'line one\n// needle line\n' },
    { cwd: '/ws', git },
  );
  const command = createFilesCommand({ host, processCwd: () => '/ws' });

  const result = (await command.handler({
    rawInput: 'src/index.ts:2',
    agent: { id: 'sess-1', session: { header: { cwd: '/ws' } } },
  })) as { kind: string; text?: string };

  assert.equal(result.kind, 'success');
  const text = result.text ?? '';
  assert.ok(text.includes('src/index.ts — file'), text);
  assert.ok(text.includes('at 2: // needle line'), text);
  assert.ok(text.includes('git: [M] Modified'), text);
  assert.ok(
    text.includes('sidebar address: dsh-resource://file/session/sess-1/src/index.ts'),
    text,
  );
  assert.ok(text.includes('client-plane'), 'host-plane degradation note expected');
});
