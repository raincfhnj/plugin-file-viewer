/**
 * Shared workspace/git lookups used by both the model tools and the `/files`
 * command: resolve the workspace base (repo root when inside a work tree,
 * otherwise the session cwd) and read the porcelain status map.
 */
import type { GitStatus, Host } from './core/types.ts';
import { repoRoot, status as gitStatus } from './core/git.ts';
import { toPosixPath } from './address.ts';

/** Resolve the workspace base (repo root when in a repo, else session cwd). */
export async function workspaceBaseFor(
  host: Host,
  cwd: string,
): Promise<{ base: string; gitRoot?: string }> {
  const gitRoot = await repoRoot(host, cwd);
  return gitRoot ? { base: gitRoot, gitRoot } : { base: toPosixPath(cwd) };
}

/** Working-tree status map keyed repo-root-relative (empty when not a repo). */
export async function gitStatusOf(
  host: Host,
  dir: string,
): Promise<Map<string, GitStatus>> {
  return await gitStatus(host, dir);
}
