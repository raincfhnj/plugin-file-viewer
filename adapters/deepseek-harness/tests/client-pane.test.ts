/**
 * Browser-half pane reactor: durable event → right-sidebar open mapping.
 * Pure events in, recorded opens out — no cordis, no DOM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPaneReactor, type PaneEventLike, type PaneReactorDeps } from '../src/client-pane.ts';

const NOW = 1_800_000_000_000;
/** Inside the 10 s skew grace window of `armedAt = NOW - 10 000`. */
const LIVE = NOW;
/** Older than the grace window → history replay, must stay silent. */
const STALE = NOW - 60_000;

const ADDRESS = 'dsh-resource://file/session/sess-1/src/index.ts';

function harness(overrides: Partial<PaneReactorDeps> = {}) {
  const files: Array<{ address: string; line?: number }> = [];
  const trees: number[] = [];
  const logs: string[] = [];
  const reactor = createPaneReactor({
    now: () => NOW,
    openFile: (address, line) => files.push({ address, line }),
    openFilesTab: () => trees.push(1),
    log: (message) => logs.push(message),
    ...overrides,
  });
  return { reactor, files, trees, logs };
}

function toolResult(data: Record<string, unknown>, time: number = LIVE): PaneEventLike {
  return { type: 'tool/result', time, data };
}

function okResult(meta?: unknown): Record<string, unknown> {
  return { message: { isError: false }, ...(meta === undefined ? {} : { meta }) };
}

test('tool/result meta.fileViewer address opens the text tab at params.line', () => {
  const { reactor, files } = harness();
  reactor.handle(
    toolResult(okResult({ fileViewer: { address: ADDRESS, line: 42 } })),
  );
  assert.deepEqual(files, [{ address: ADDRESS, line: 42 }]);
});

test('tool/result without fileViewer meta opens nothing', () => {
  const { reactor, files, trees } = harness();
  reactor.handle(toolResult(okResult()));
  reactor.handle(toolResult(okResult({ somethingElse: 1 })));
  reactor.handle(toolResult({ message: { isError: false } }));
  assert.equal(files.length, 0);
  assert.equal(trees.length, 0);
});

test('tool/result fileViewer.tab=files opens the workspace tree tab', () => {
  const { reactor, trees, files } = harness();
  reactor.handle(toolResult(okResult({ fileViewer: { tab: 'files' } })));
  assert.equal(trees.length, 1);
  assert.equal(files.length, 0);
});

test('absolute-scope addresses are skipped (the file provider rejects them)', () => {
  const { reactor, files, logs } = harness();
  reactor.handle(
    toolResult(
      okResult({ fileViewer: { address: 'dsh-resource://file/absolute/C:/x/y.txt' } }),
    ),
  );
  assert.equal(files.length, 0);
  assert.ok(logs.some((line) => line.includes('outside the workspace')), logs.join('\n'));
});

test('failed tool results never open a pane, even with meta attached', () => {
  const { reactor, files, trees } = harness();
  const withMeta = { fileViewer: { address: ADDRESS } };
  reactor.handle(
    toolResult({ message: { isError: true }, meta: withMeta }),
  );
  reactor.handle(toolResult({ error: { name: 'X', code: 'E' }, meta: withMeta }));
  assert.equal(files.length, 0);
  assert.equal(trees.length, 0);
});

test('history replay before armedAt stays silent', () => {
  const { reactor, files, trees } = harness();
  reactor.handle(
    toolResult(okResult({ fileViewer: { address: ADDRESS, line: 1 } }), STALE),
  );
  reactor.handle(
    {
      type: 'command/done',
      time: STALE,
      data: {
        commandId: 'c1',
        kind: 'success',
        text: `src/index.ts — file\nsidebar address: ${ADDRESS}`,
      },
    },
  );
  assert.equal(files.length, 0);
  assert.equal(trees.length, 0);
});

test('/files command run+done opens the target file at the typed line', () => {
  const { reactor, files } = harness();
  reactor.handle({
    type: 'command/run',
    time: LIVE,
    data: { commandId: 'c1', name: 'files', args: 'src/index.ts:7' },
  });
  reactor.handle({
    type: 'command/done',
    time: LIVE,
    data: {
      commandId: 'c1',
      kind: 'success',
      text: [
        'src/index.ts — file, 42 bytes, 3 lines',
        `sidebar address: ${ADDRESS}`,
        'note: …',
      ].join('\n'),
    },
  });
  assert.deepEqual(files, [{ address: ADDRESS, line: 7 }]);
});

test('/files on a directory opens the files tab; failed commands open nothing', () => {
  const { reactor, files, trees } = harness();
  reactor.handle({
    type: 'command/run',
    time: LIVE,
    data: { commandId: 'c2', name: 'files', args: 'src' },
  });
  reactor.handle({
    type: 'command/done',
    time: LIVE,
    data: {
      commandId: 'c2',
      kind: 'success',
      text: `# file tree — root "src" of /ws\nsidebar address: dsh-resource://file/session/sess-1/src`,
    },
  });
  reactor.handle({
    type: 'command/run',
    time: LIVE,
    data: { commandId: 'c3', name: 'files', args: 'nope.ts' },
  });
  reactor.handle({
    type: 'command/done',
    time: LIVE,
    data: { commandId: 'c3', kind: 'error', text: 'not found: nope.ts' },
  });
  assert.equal(trees.length, 1);
  assert.equal(files.length, 0);
});

test('other commands and junk events are ignored without throwing', () => {
  const { reactor, files, trees } = harness();
  reactor.handle({
    type: 'command/run',
    time: LIVE,
    data: { commandId: 'c4', name: 'plan', args: 'x' },
  });
  reactor.handle({
    type: 'command/done',
    time: LIVE,
    data: { commandId: 'c4', kind: 'success', text: `sidebar address: ${ADDRESS}` },
  });
  reactor.handle(null as never);
  reactor.handle({ type: 42, time: LIVE, data: null });
  reactor.handle({ type: 'tool/result', time: 'not-a-number', data: { meta: 7 } });
  reactor.handle({ type: 'assistant/message', time: LIVE, data: {} });
  assert.equal(files.length, 0);
  assert.equal(trees.length, 0);
});

test('a throwing openResource is contained and logged', () => {
  const logs: string[] = [];
  const { reactor } = harness({
    openFile: () => {
      throw new Error('no surface');
    },
    log: (message) => logs.push(message),
  });
  reactor.handle(toolResult(okResult({ fileViewer: { address: ADDRESS } })));
  assert.ok(logs.some((line) => line.includes('openResource failed')), logs.join('\n'));
});
