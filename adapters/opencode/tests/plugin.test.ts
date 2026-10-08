/**
 * Plugin-level tests: the loader contract (default-export shape) plus an
 * end-to-end run of the four registered tools against this repository with the
 * real node Host and real git. Restart-free: these call the plugin function
 * directly instead of going through the opencode loader (see README for the
 * `opencode debug info` smoke test that covers loading).
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { PluginInput, ToolContext, ToolDefinition, ToolResult } from '@opencode-ai/plugin';
import pluginModule from '../plugin.ts';
import * as pluginExports from '../plugin.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function fakeInput(directory: string): PluginInput {
  return { directory, worktree: directory } as unknown as PluginInput;
}

function fakeCtx(directory: string): ToolContext {
  return {
    sessionID: 'ses_test',
    messageID: 'msg_test',
    agent: 'build',
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata() {},
    ask: async () => {},
  } as unknown as ToolContext;
}

function out(result: ToolResult): string {
  return typeof result === 'string' ? result : result.output;
}

test('loader rule: every runtime export of plugin.ts is a function', () => {
  const values = Object.values(pluginExports);
  assert.ok(values.length >= 1);
  for (const value of values) {
    assert.equal(typeof value, 'function', 'plugin entry may only export functions');
  }
});

test('plugin registers the four tools with descriptions and arg schemas', async () => {
  const hooks = await pluginModule(fakeInput(REPO_ROOT));
  const tools: Record<string, ToolDefinition> = hooks.tool ?? {};
  assert.deepEqual(Object.keys(tools).sort(), [
    'content_search',
    'file_diff',
    'file_search',
    'file_tree',
  ]);
  for (const name of Object.keys(tools)) {
    const def = tools[name]!;
    assert.equal(typeof def.execute, 'function', `${name}.execute`);
    assert.ok(def.description.length > 40, `${name} needs a real description`);
    assert.equal(typeof def.args, 'object', `${name}.args`);
  }
  assert.equal('event' in hooks, false);
});

test('file_tree works end-to-end through the registered tool', async () => {
  const hooks = await pluginModule(fakeInput(REPO_ROOT));
  const result = await hooks.tool!.file_tree!.execute({ depth: 1 }, fakeCtx(REPO_ROOT));
  const text = out(result);
  assert.match(text, /^# file_tree path=\. git=yes depth=1 rows=\d+$/m);
  assert.match(text, /\n {4}[▸▾] adapters[~]?\n/);
});

test('file_search / content_search / file_diff work end-to-end', async () => {
  const hooks = await pluginModule(fakeInput(REPO_ROOT));
  const ctx = fakeCtx(REPO_ROOT);

  const search = out(await hooks.tool!.file_search!.execute({ query: 'view_policy' }, ctx));
  assert.match(search, /^# file_search "view_policy" hits=\d+ scanned=\d+$/m);
  assert.match(search, /adapters\/opencode\/core\/view_policy\.ts/);

  const content = out(await hooks.tool!.content_search!.execute({ query: 'rowLabel', limit: 5 }, ctx));
  assert.match(content, /^# content_search "rowLabel" matches=\d+ limit=5$/m);
  assert.match(content, /adapters\/claude-code\/hooks\/pane\.ts:\d+: .*rowLabel/);

  const diff = out(await hooks.tool!.file_diff!.execute({ path: 'package.json' }, ctx));
  assert.match(diff, /^# file_diff package\.json baseline=HEAD git=yes view=\w+ modes=/);
});
