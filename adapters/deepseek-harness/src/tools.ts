/**
 * The three model tools: `file_tree`, `file_diff`, `content_search`.
 *
 * Each `create*Tool` returns a `defineTool(...)` definition ready for
 * `ctx.tools.register(...)`; the heavy lifting lives in exported
 * `build*Text` helpers so tests can exercise the same code paths the tools run
 * with a fake `Host`.
 *
 * Path namespace: tool `path` arguments are workspace-root-relative — the git
 * repo root when the session cwd is inside a repo, otherwise the session cwd.
 * When those two differ, a rooted `Host` wrapper translates to cwd-relative
 * filesystem access while rows/keys stay root-relative.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Host } from './core/types.ts';
import type { Baseline } from './core/types.ts';
import { defaultBaseBranch, fileDiff, isRepo } from './core/git.ts';
import { gitStatusOf, workspaceBaseFor } from './git-bridge.ts';
import { createTreeState, listRows } from './core/tree.ts';
import { searchContent } from './core/search.ts';
import { isAbsolutePath, relativeToWorkspace, toPosixPath } from './address.ts';
import {
  appendSidebarMeta,
  fileViewerMetaOf,
  sessionFileAddress,
  stripSidebarMeta,
} from './meta.ts';
import {
  DEFAULT_DIFF_CHARS,
  DEFAULT_SEARCH_LIMIT,
  DEFAULT_TREE_ROWS,
  MAX_SEARCH_LIMIT,
  MAX_TREE_ROWS,
  formatDiff,
  formatSearch,
  formatTreeRows,
} from './format.ts';

export interface ToolDeps {
  host: Host;
  /** Fallback working directory when the execution has no session (process.cwd()). */
  processCwd: () => string;
}

/** Minimal structural view of the execution's agent (real: dsh Agent).
 * `agent.id` IS the Session id (`Agent.id: SessionId`, dsh-agent types), which
 * is what `dsh-resource://file/session/<id>/…` addresses need.
 */
interface AgentLike {
  id?: string;
  session?: { header?: { cwd?: string } };
}

interface ExecLike {
  agent?: AgentLike;
}

/** Session cwd when the execution carries an agent, else the process cwd. */
export function execCwd(exec: ExecLike | undefined, fallback: () => string): string {
  const cwd = exec?.agent?.session?.header?.cwd;
  return cwd && cwd.length > 0 ? cwd : toPosixPath(fallback());
}

const clampInt = (value: number | undefined, lo: number, hi: number, fallback: number): number => {
  const v = Number.isFinite(value) ? Math.round(value as number) : fallback;
  return Math.min(hi, Math.max(lo, v));
};

/** Heavy directories the tree never descends into (core's walk has no ignore rules). */
const SKIP_DESCEND = new Set(['node_modules']);

/** Join a git-root-relative path onto a cwd→root translation prefix. */
function joinPrefix(prefix: string, rel: string): string {
  if (!prefix) return rel;
  if (!rel) return prefix;
  if (isAbsolutePath(rel)) return rel;
  return `${prefix}/${rel}`;
}

/**
 * Wrap `inner` so git-root-relative paths translate to cwd-relative
 * filesystem access; absolute paths (git working dirs) pass through.
 * `prefix` is the `../` chain from session cwd up to the repo root ('' when equal).
 */
function rootedHost(inner: Host, prefix: string): Host {
  if (!prefix) return inner;
  return {
    isWindows: inner.isWindows,
    cwd: () => inner.cwd(),
    listDir: (rel) => inner.listDir(joinPrefix(prefix, rel)),
    readText: (rel) => inner.readText(joinPrefix(prefix, rel)),
    exists: (rel) => inner.exists(joinPrefix(prefix, rel)),
    runGit: (dir, args) => inner.runGit(dir, args),
  };
}

/** `../` chain walking from `cwd` up to ancestor `root` ('' when equal). */
function prefixToRoot(cwd: string, root: string): string {
  const down = relativeToWorkspace(root, cwd);
  if (down === undefined || down === '') return '';
  return '../'.repeat(down.split('/').length);
}

/** Translate a user/tool `path` into the base namespace (root-relative). */
function toBaseRel(base: string, input: string | undefined): string {
  if (!input) return '';
  const norm = toPosixPath(input);
  if (isAbsolutePath(norm)) {
    return relativeToWorkspace(base, norm) ?? norm;
  }
  return norm.replace(/^\.\//, '').replace(/^\/+/, '');
}

export interface TreeToolArgs {
  path?: string;
  changed_only?: boolean;
  max_rows?: number;
  max_depth?: number;
  show_hidden?: boolean;
}

/** Build the `file_tree` output text (workspace-root-relative rows). */
export async function buildFileTreeText(
  host: Host,
  cwd: string,
  args: TreeToolArgs = {},
): Promise<string> {
  const { base, gitRoot } = await workspaceBaseFor(host, cwd);
  const root = toBaseRel(base, args.path);
  const fsHost = rootedHost(host, gitRoot ? prefixToRoot(toPosixPath(cwd), gitRoot) : '');
  const changedOnly = args.changed_only ?? false;
  const hideHidden = !(args.show_hidden ?? false);
  const maxRows = clampInt(args.max_rows, 1, MAX_TREE_ROWS, DEFAULT_TREE_ROWS);
  const maxDepth = clampInt(args.max_depth, 1, 24, 6);

  const statusMap = await gitStatusOf(host, gitRoot ?? base);
  const notes: string[] = [];
  if (statusMap.size === 0) {
    notes.push(
      (await isRepo(host, gitRoot ?? base))
        ? '(git: working tree clean — no status markers)'
        : '(not a git repository — no status markers)',
    );
  }

  const title = `# file tree — root "${root || '.'}" of ${base}`;
  const treeOpts = { changedOnly, hideHidden };

  if (changedOnly) {
    const rows = await listRows(fsHost, createTreeState(root), statusMap, treeOpts);
    if (rows.length === 0) notes.unshift('(no changed files)');
    return formatTreeRows(rows, { maxRows, title, notes });
  }

  if (root && !(await fsHost.exists(root))) {
    return [title, `(path not found: ${root})`].join('\n');
  }

  // listRows only descends into expanded dirs; grow the expansion level by
  // level until the depth budget is spent or the row budget is reached.
  let state = createTreeState(root);
  let rows = await listRows(fsHost, state, statusMap, treeOpts);
  for (;;) {
    if (rows.length >= maxRows) break;
    const expanded = new Set(state.expanded);
    let changed = false;
    for (const row of rows) {
      // Children of this dir land at row.depth + 1; expand only while those
      // children stay inside the budget (visible rows have depth < max_depth).
      if (row.kind !== 'dir' || row.depth + 1 >= maxDepth) continue;
      if (expanded.has(row.path)) continue;
      const name = row.path.split('/').pop() ?? row.path;
      if (SKIP_DESCEND.has(name)) continue;
      expanded.add(row.path);
      changed = true;
    }
    if (!changed) break;
    state = { ...state, expanded };
    rows = await listRows(fsHost, state, statusMap, treeOpts);
  }

  return formatTreeRows(rows, { maxRows, title, notes });
}

export interface DiffToolArgs {
  path: string;
  baseline?: string;
  base_branch?: string;
  full_context?: boolean;
}

/** Build the `file_diff` output text. `sessionId` appends sidebar metadata
 * (stripped from model content, projected into `tool/result.meta`). */
export async function buildFileDiffText(
  host: Host,
  cwd: string,
  args: DiffToolArgs,
  sessionId?: string,
): Promise<string> {
  const { base, gitRoot } = await workspaceBaseFor(host, cwd);
  const rel = toBaseRel(base, args.path);
  const repoDir = gitRoot ?? base;

  if (!(await isRepo(host, repoDir))) {
    const note = [`# diff ${rel || args.path} vs HEAD`, '(not a git repository — diff unavailable)'].join(
      '\n',
    );
    const noteAddress = sessionFileAddress(sessionId, cwd, base, rel || args.path, note);
    return noteAddress ? appendSidebarMeta(note, { address: noteAddress }) : note;
  }

  // Report the baseline git will actually diff against: 'Base' with no base
  // branch (and no explicit override) degrades to HEAD inside core's fileDiff,
  // so resolve that here to keep the heading honest.
  let baseline: Baseline = args.baseline === 'Base' && !args.base_branch ? 'Base' : 'HEAD';
  if (baseline === 'Base' && !(await defaultBaseBranch(host, repoDir))) baseline = 'HEAD';
  const heading = `# diff ${rel || args.path} vs ${baseline}`;

  const statusMap = await gitStatusOf(host, repoDir);
  const st = rel ? statusMap.get(rel) : undefined;
  // Deleted paths (git status still knows them) and untracked paths may be
  // absent from the exists() probe only in odd fixtures — deleted files must
  // still diff, so gate the not-found notice on the status.
  if (
    rel &&
    st !== 'Deleted' &&
    st !== 'Untracked' &&
    !(await rootedHost(host, gitRoot ? prefixToRoot(toPosixPath(cwd), gitRoot) : '').exists(rel))
  ) {
    return [heading, `(path not found: ${rel})`].join('\n');
  }

  const text = await fileDiff(host, repoDir, rel, baseline, {
    baseBranch: args.base_branch,
    fullContext: args.full_context,
  });
  const formatted = formatDiff(rel || args.path, baseline, text, { maxChars: DEFAULT_DIFF_CHARS });
  // Deleted files have no on-disk content to preview; everything else in the
  // workspace gets a session-scope address for the right-sidebar auto-open.
  const address =
    st === 'Deleted' ? undefined : sessionFileAddress(sessionId, cwd, base, rel || args.path);
  return address ? appendSidebarMeta(formatted, { address }) : formatted;
}

export interface SearchToolArgs {
  query: string;
  path?: string;
  limit?: number;
}

/** Build the `content_search` output text (`path:line` rows). `sessionId`
 * appends a sidebar address/line for the first match (host-only metadata). */
export async function buildSearchText(
  host: Host,
  cwd: string,
  args: SearchToolArgs,
  sessionId?: string,
): Promise<string> {
  const { base, gitRoot } = await workspaceBaseFor(host, cwd);
  const root = toBaseRel(base, args.path);
  const fsHost = rootedHost(host, gitRoot ? prefixToRoot(toPosixPath(cwd), gitRoot) : '');
  const limit = clampInt(args.limit, 1, MAX_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT);

  if (root && !(await fsHost.exists(root))) {
    return `(path not found: ${root})`;
  }
  const matches = await searchContent(fsHost, root, args.query, { limit });
  const text = formatSearch(matches, {
    query: args.query,
    limit,
    limitHit: matches.length >= limit,
  });
  const first = matches[0];
  const address = first ? sessionFileAddress(sessionId, cwd, base, first.path) : undefined;
  return address ? appendSidebarMeta(text, { address, line: first!.line }) : text;
}

const TREE_DESCRIPTION =
  'List the workspace as a tree with git status markers. Paths are workspace-root-relative ' +
  '(repo root when inside a git repository). Directories are expanded progressively up to ' +
  'max_depth; node_modules is never descended into. Read-only.';

const DIFF_DESCRIPTION =
  'Unified git diff for one file: baseline=HEAD compares against HEAD (untracked files show as ' +
  'whole-file additions), baseline=Base compares against the merge-base of the default base ' +
  'branch. Paths are workspace-root-relative. Read-only.';

const SEARCH_DESCRIPTION =
  'Literal, ASCII case-insensitive content search returning path:line matches with bounded ' +
  'excerpts. Skips hidden entries, node_modules, binary and oversized files. Read-only.';

/** Register-ready `file_tree` definition. */
export function createFileTreeTool(deps: ToolDeps) {
  return defineTool({
    name: 'file_tree',
    description: TREE_DESCRIPTION,
    parameters: {
      path: {
        type: 'string',
        description: 'Directory to list, workspace-root-relative. Default: the workspace root.',
      },
      changed_only: {
        type: 'boolean',
        description: 'Synthesize a tree of only git-changed files (default false).',
      },
      max_rows: {
        type: 'integer',
        description: `Row budget before truncation (default ${DEFAULT_TREE_ROWS}, max ${MAX_TREE_ROWS}).`,
      },
      max_depth: {
        type: 'integer',
        description: 'Directory levels to descend, default 6 (root children are depth 0).',
      },
      show_hidden: {
        type: 'boolean',
        description: 'Include dotfiles/dotdirs (default false; .git is always excluded).',
      },
    },
    output: {
      schema: { type: 'string' },
      // Sidebar metadata lives in the canonical value only: stripped from the
      // model-facing text, re-projected into tool/result.meta for the browser
      // half's right-sidebar auto-open (src/client.ts).
      render: (_args, value) => [{ type: 'text', text: stripSidebarMeta(value) }],
      presentationMeta: (_args, value) => fileViewerMetaOf(value),
    },
    async execute(args, exec) {
      return await buildFileTreeText(deps.host, execCwd(exec, deps.processCwd), args);
    },
  });
}

/** Register-ready `file_diff` definition. */
export function createFileDiffTool(deps: ToolDeps) {
  return defineTool({
    name: 'file_diff',
    description: DIFF_DESCRIPTION,
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'File to diff, workspace-root-relative.',
      },
      baseline: {
        type: 'string',
        enum: ['HEAD', 'Base'],
        default: 'HEAD',
        description: 'HEAD (default) or Base (merge-base with the base branch).',
      },
      base_branch: {
        type: 'string',
        description: 'Override the base branch for baseline=Base, e.g. origin/main.',
      },
      full_context: {
        type: 'boolean',
        description: 'Show the whole file as context instead of 3 lines (default false).',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: stripSidebarMeta(value) }],
      presentationMeta: (_args, value) => fileViewerMetaOf(value),
    },
    async execute(args, exec) {
      const cwd = execCwd(exec, deps.processCwd);
      return await buildFileDiffText(deps.host, cwd, args, exec?.agent?.id);
    },
  });
}

/** Register-ready `content_search` definition. */
export function createContentSearchTool(deps: ToolDeps) {
  return defineTool({
    name: 'content_search',
    description: SEARCH_DESCRIPTION,
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Literal substring to find (ASCII case-insensitive).',
      },
      path: {
        type: 'string',
        description: 'Subdirectory to search, workspace-root-relative. Default: whole workspace.',
      },
      limit: {
        type: 'integer',
        description: `Max matches (default ${DEFAULT_SEARCH_LIMIT}, max ${MAX_SEARCH_LIMIT}).`,
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: stripSidebarMeta(value) }],
      presentationMeta: (_args, value) => fileViewerMetaOf(value),
    },
    async execute(args, exec) {
      const cwd = execCwd(exec, deps.processCwd);
      return await buildSearchText(deps.host, cwd, args, exec?.agent?.id);
    },
  });
}
