/**
 * Tree model — visible rows over an expanded set, with git markers.
 * Port of herdr-file-viewer src/tree.rs (v0.1): full walk + changed-only synthesis.
 * Not ported (v0.2): compact_dirs folding, mouse, show_ignored.
 *
 * Frozen signatures (ARCHITECTURE.md §3): createTreeState / toggle / select /
 * listRows / nextChanged / TreeState / TreeOptions / DEFAULT_TREE_OPTIONS.
 */
import type { DirEntry, GitStatus, Host, NodeKind, TreeNode } from './types.ts';

export interface TreeOptions {
  /** Synthesize a tree containing only changed paths (AC-6). */
  changedOnly: boolean;
  /** Hide dotfiles/dotdirs (except '.'-root basics). */
  hideHidden: boolean;
}

export const DEFAULT_TREE_OPTIONS: TreeOptions = { changedOnly: false, hideHidden: true };

export interface TreeState {
  /** Repo-root-relative root, POSIX ('' = repo root). */
  root: string;
  expanded: Set<string>;
  selected?: { path: string; kind: NodeKind };
}

export function createTreeState(root = ''): TreeState {
  return { root, expanded: new Set(['']) };
}

export function toggle(state: TreeState, path: string): TreeState {
  const expanded = new Set(state.expanded);
  if (expanded.has(path)) expanded.delete(path);
  else expanded.add(path);
  return { ...state, expanded };
}

export function select(path: string, kind: NodeKind): (s: TreeState) => TreeState {
  return (s) => ({ ...s, selected: { path, kind } });
}

/**
 * Produce the visible rows for the current expansion state (tree.rs `visible_nodes`).
 * Directories before files, alphabetical within each group (cmp_sibling); status
 * markers come from `statusMap` (repo-root-relative POSIX keys); `dirDirty` is a
 * component-wise prefix inference over `statusMap`, so collapsed dirs get it too.
 * statusMap empty (no git repo) + changedOnly → empty rows.
 */
export async function listRows(
  host: Host,
  state: TreeState,
  statusMap: Map<string, GitStatus>,
  opts: TreeOptions = DEFAULT_TREE_OPTIONS,
): Promise<TreeNode[]> {
  if (opts.changedOnly) return changedOnlyRows(state, statusMap);

  const rows: TreeNode[] = [];
  await walk(state.root, 0);
  return rows;

  async function walk(dir: string, depth: number): Promise<void> {
    let entries: DirEntry[];
    try {
      entries = await host.listDir(dir);
    } catch {
      return; // empty dir / permission error: skip this subtree, keep the rest
    }
    entries = entries
      .filter((e) => !(opts.hideHidden && e.name.startsWith('.')))
      .filter((e) => e.name !== '.git')
      .sort((a, b) => cmpSibling(a.name, a.kind, b.name, b.kind));
    for (const e of entries) {
      const path = dir === '' ? e.name : `${dir}/${e.name}`;
      if (e.kind === 'dir') {
        const expanded = state.expanded.has(path);
        rows.push({
          path,
          kind: 'dir',
          depth,
          expanded,
          status: statusMap.get(path),
          dirDirty: dirHasChange(statusMap, path),
        });
        if (expanded) await walk(path, depth + 1);
      } else {
        rows.push({
          path,
          kind: 'file',
          depth,
          expanded: false,
          status: statusMap.get(path),
          dirDirty: false,
        });
      }
    }
  }
}

/** Next/previous visible file with a status, wrapping; undefined when none. */
export function nextChanged(
  rows: TreeNode[],
  currentPath: string | undefined,
  dir: 1 | -1,
): string | undefined {
  const changed = (r: TreeNode): boolean => r.kind === 'file' && r.status !== undefined;
  if (!rows.some(changed)) return undefined;
  const cur = currentPath === undefined ? -1 : rows.findIndex((r) => r.path === currentPath);
  if (cur === -1) {
    const files = rows.filter(changed);
    return dir === 1 ? files[0]!.path : files[files.length - 1]!.path;
  }
  for (let step = 1; step <= rows.length; step++) {
    const i = (((cur + dir * step) % rows.length) + rows.length) % rows.length;
    const r = rows[i]!;
    if (changed(r)) return r.path;
  }
  return undefined;
}

/** cmp_sibling (tree.rs): directories before files, then name — Rust OsStr byte
 * order ≈ JS UTF-16 code-unit order for the ASCII names a repo tree sees. */
function cmpSibling(aName: string, aKind: NodeKind, bName: string, bKind: NodeKind): number {
  const dirs = (bKind === 'dir' ? 1 : 0) - (aKind === 'dir' ? 1 : 0);
  if (dirs !== 0) return dirs;
  return aName < bName ? -1 : aName > bName ? 1 : 0;
}

/** The path's parent ('' at the top level). */
function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/** The path's final component. */
function nameOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/**
 * dir_dirty (tree.rs dir_contains_change): any changed file lives under `dir`.
 * Component-wise prefix match (`src` is never dirtied by `src2/…`, the dir's own
 * path excluded) over the status map — cheap, so collapsed dirs get it too.
 */
function dirHasChange(statusMap: Map<string, GitStatus>, dir: string): boolean {
  const prefix = dir + '/';
  for (const key of statusMap.keys()) {
    if (key !== dir && key.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * changed-only synthesis (tree.rs changed_only_nodes/emit_synthetic): rows come
 * from the status map, never the filesystem, so deleted paths — and files under a
 * deleted directory — still get rows. Only changed files and their ancestor dirs;
 * dirs are expanded and dirty by construction; no display filter applies (the
 * Rust emitter has none either).
 */
function changedOnlyRows(state: TreeState, statusMap: Map<string, GitStatus>): TreeNode[] {
  const prefix = state.root === '' ? '' : state.root + '/';
  const files = [...statusMap.keys()].filter((k) => k.startsWith(prefix));
  const dirs = new Set<string>();
  for (const f of files) {
    let a = parentOf(f);
    while (a !== '' && a !== state.root) {
      dirs.add(a);
      a = parentOf(a);
    }
  }

  const rows: TreeNode[] = [];
  emit(state.root, 0);
  return rows;

  function emit(parent: string, depth: number): void {
    const children: Array<{ path: string; kind: NodeKind }> = [];
    for (const d of dirs) if (parentOf(d) === parent) children.push({ path: d, kind: 'dir' });
    for (const f of files) if (parentOf(f) === parent) children.push({ path: f, kind: 'file' });
    children.sort((a, b) => cmpSibling(nameOf(a.path), a.kind, nameOf(b.path), b.kind));
    for (const c of children) {
      if (c.kind === 'dir') {
        rows.push({
          path: c.path,
          kind: 'dir',
          depth,
          expanded: true,
          status: statusMap.get(c.path),
          dirDirty: true, // ancestor of a changed file by construction
        });
        emit(c.path, depth + 1);
      } else {
        rows.push({
          path: c.path,
          kind: 'file',
          depth,
          expanded: false,
          status: statusMap.get(c.path),
          dirDirty: false,
        });
      }
    }
  }
}
