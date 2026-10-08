/**
 * Host tests over the real filesystem and real git (read-only commands only:
 * rev-parse / status, with SAFE_GIT_FLAGS applied by Host.runGit).
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHost, normalizePath, resolveRepo } from '../host.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('normalizePath converts Windows separators and keeps drive roots', () => {
  assert.equal(normalizePath('D:\\1024\\my\\repo'), 'D:/1024/my/repo');
  assert.equal(normalizePath('D:/1024/my/repo/'), 'D:/1024/my/repo');
  assert.equal(normalizePath('C:/'), 'C:/');
  assert.equal(normalizePath('/'), '/');
});

test('createHost lists, reads and stats through POSIX relative paths', async () => {
  const host = createHost(REPO_ROOT, REPO_ROOT);
  assert.equal(host.isWindows, process.platform === 'win32');
  assert.equal(host.cwd(), normalizePath(REPO_ROOT));

  const top = await host.listDir('');
  assert.ok(top.some((e) => e.name === 'adapters' && e.kind === 'dir'));
  assert.ok(top.some((e) => e.name === 'package.json' && e.kind === 'file' && (e.size ?? 0) > 0));
  assert.equal((await host.listDir('no-such-dir')).length, 0);

  const pkg = await host.readText('package.json');
  assert.match(pkg, /"name": "plugin-file-viewer"/);

  assert.equal(await host.exists('LICENSE'), true);
  assert.equal(await host.exists('no/such/file.ts'), false);
  await assert.rejects(() => host.readText('no/such/file.ts'));
});

test('runGit carries the safety flags and answers for this repository', async () => {
  const host = createHost(REPO_ROOT, REPO_ROOT);
  const inside = await host.runGit(REPO_ROOT, ['rev-parse', '--is-inside-work-tree']);
  assert.equal(inside.exitCode, 0);
  assert.equal(inside.stdout.trim(), 'true');

  const top = await host.runGit(REPO_ROOT, ['rev-parse', '--show-toplevel']);
  assert.equal(top.exitCode, 0);
  assert.match(top.stdout.trim(), /^[A-Za-z]:\/|^\//); // POSIX-normalized by repoRoot
  assert.doesNotMatch(top.stdout, /\\/);
});

test('resolveRepo roots the host at the git toplevel', async () => {
  const repo = await resolveRepo(path.join(REPO_ROOT, 'adapters', 'opencode'));
  assert.equal(repo.git, true);
  assert.equal(repo.root, normalizePath(REPO_ROOT));
  assert.equal(repo.host.cwd(), normalizePath(path.join(REPO_ROOT, 'adapters', 'opencode')));
  // relative resolution now starts at the repo root, not the session dir
  assert.equal(await repo.host.exists('package.json'), true);
});
