/**
 * OpenCode tool bodies — pure logic over `./core/*` plus text formatting.
 *
 * `plugin.ts` wraps each exported function in @opencode-ai/plugin's `tool()`
 * (zod args + description); the loader rule only constrains the plugin entry
 * module, so this module stays node-free and testable with a fake Host.
 *
 * Output contract: `{ title, output }` where `output` is model-facing text,
 * truncated at OUTPUT_LIMIT with an explicit note.
 */
import type { Baseline, ChangedFileView, GitStatus, Host, TreeNode } from './core/types.ts';
import { createTreeState, listRows } from './core/tree.ts';
import { fileDiff as gitFileDiff, status as gitStatus } from './core/git.ts';
import { fuzzyFilter } from './core/fuzzy.ts';
import { searchContent } from './core/search.ts';
import { applicableModes, defaultMode, describeFile } from './core/view_policy.ts';

/** Everything a tool needs: host rooted at `root`, plus whether git answered. */
export interface RepoContext {
  /** Host whose relative paths resolve against `root`. */
  host: Host;
  /** Absolute POSIX root (repo root, or the session directory outside a repo). */
  root: string;
  /** true when `root` came from git — status/diff are available. */
  git: boolean;
}

/** Model-facing tool result: short title for the transcript, text for the LLM. */
export interface ToolOutput {
  title: string;
  output: string;
}

/** Characters handed to the model before truncation. */
export const OUTPUT_LIMIT = 50 * 1024;

/** Default tree depth (levels shown below the start path). */
export const DEFAULT_DEPTH = 3;
const MIN_DEPTH = 1;
const MAX_DEPTH = 10;
/** content_search defaults/limits (core's own default is 200). */
const DEFAULT_SEARCH_LIMIT = 100;
const MAX_SEARCH_LIMIT = 500;
/** file_search caps its ranked list. */
const FILE_SEARCH_LIMIT = 50;

/** Cut `text` to `limit`, appending an explicit truncation note. */
export function fit(text: string, limit = OUTPUT_LIMIT): string {
  if (text.length <= limit) return text;
  const note = `\n… [truncated: kept ${limit} of ${text.length} chars]`;
  return text.slice(0, Math.max(0, limit - note.length)) + note;
}

function baseName(path: string): string {
  const at = path.lastIndexOf('/');
  return at === -1 ? path : path.slice(at + 1);
}

/** Tree status mark (pane.ts statusMark): M / A / D / ?, blank for dirs/clean. */
export function statusMark(row: TreeNode): string {
  if (row.kind === 'dir') return ' ';
  switch (row.status) {
    case 'Modified':
      return 'M';
    case 'Added':
      return 'A';
    case 'Deleted':
      return 'D';
    case 'Untracked':
      return '?';
    default:
      return ' ';
  }
}

/**
 * One tree row in the claude-code pane's label format: 2-column selection slot
 * (always blank here), status mark, 2-spaces-per-depth indent, dir caret, name,
 * and `~` on a directory containing changes (dirDirty).
 */
export function rowLabel(row: TreeNode): string {
  const mark = statusMark(row) + ' ';
  const indent = '  '.repeat(Math.max(0, row.depth));
  const caret = row.kind === 'dir' ? (row.expanded ? '▾ ' : '▸ ') : '';
  const name = baseName(row.path) + (row.kind === 'dir' && row.dirDirty ? '~' : '');
  return '  ' + mark + indent + caret + name;
}

/** Input path → root-relative POSIX ('' = root). Absolute paths under the root
 * are stripped to it; other absolutes pass through and fail the exists check. */
export function toRel(root: string, input: string): string {
  let p = input.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (p === '') return '';
  const base = normalizeRoot(root);
  if (base !== '' && (p === base || p.startsWith(base + '/'))) p = p.slice(base.length);
  return p.replace(/^\//, '');
}

function normalizeRoot(root: string): string {
  const norm = root.replace(/\\/g, '/').replace(/\/+$/, '');
  return norm === '' || norm.endsWith(':') ? root.replace(/\\/g, '/') : norm;
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** Direct child directories of `dir`, hidden and `.git` excluded. */
async function childDirs(host: Host, dir: string): Promise<string[]> {
  const entries = await host.listDir(dir);
  const out: string[] = [];
  for (const e of entries) {
    if (e.kind !== 'dir' || e.name.startsWith('.') || e.name === '.git') continue;
    out.push(dir === '' ? e.name : `${dir}/${e.name}`);
  }
  return out;
}

/**
 * Expansion set that renders rows down to row depth `levels` below `start`:
 * `levels = depth - 1` (depth counts entries, root children are depth 0).
 */
async function expandToDepth(host: Host, start: string, levels: number): Promise<Set<string>> {
  const expanded = new Set<string>([start]);
  let frontier = await childDirs(host, start);
  for (let i = 0; i < levels && frontier.length > 0; i++) {
    for (const dir of frontier) expanded.add(dir);
    const next: string[] = [];
    for (const dir of frontier) next.push(...(await childDirs(host, dir)));
    frontier = next;
  }
  return expanded;
}

/** Every file under the host root, POSIX paths, deterministic name order; hidden,
 * node_modules and `.git` skipped (mirrors the content-search walk). Core paths
 * are repo-root-relative, so the walk starts at `''`. */
async function collectFiles(host: Host): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await host.listDir(dir);
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const path = dir === '' ? e.name : `${dir}/${e.name}`;
      if (e.kind === 'dir') await walk(path);
      else out.push(path);
    }
  };
  await walk('');
  return out;
}

export interface FileTreeArgs {
  /** Start directory (repo-relative or absolute); '' = root. */
  path?: string;
  /** Levels to show below `path` (1–10, default 3). */
  depth?: number;
  /** Only paths with git changes (synthesized from status, ignores depth). */
  changedOnly?: boolean;
}

/** `file_tree` — indented rows with git marks, pane.ts rowLabel format. */
export async function fileTree(repo: RepoContext, args: FileTreeArgs = {}): Promise<ToolOutput> {
  const { host, root, git } = repo;
  const start = toRel(root, args.path ?? '');
  const changedOnly = args.changedOnly === true;
  const depth = clampInt(args.depth, MIN_DEPTH, MAX_DEPTH, DEFAULT_DEPTH);
  const title = `file_tree ${start === '' ? '.' : start}`;

  if (start !== '' && !(await host.exists(start))) {
    return { title, output: `file_tree: path not found: ${start}` };
  }
  if (changedOnly && !git) {
    return { title, output: 'file_tree: changed_only needs a git repository (none found)' };
  }

  const statusMap = git ? await gitStatus(host, root) : new Map<string, GitStatus>();
  const state = createTreeState(start);
  if (!changedOnly) state.expanded = await expandToDepth(host, start, depth - 1);
  const rows = await listRows(host, state, statusMap, { changedOnly, hideHidden: true });

  const head = `# file_tree path=${start === '' ? '.' : start} git=${git ? 'yes' : 'no'} depth=${depth} rows=${rows.length}`;
  const legend = rows.some((r) => r.status !== undefined || r.dirDirty)
    ? '\n# marks: M modified  A added  D deleted  ? untracked  ~ dir has changes'
    : '';
  let body: string;
  if (rows.length === 0) body = changedOnly ? '\n(no changed files)' : '\n(no entries)';
  else body = '\n' + rows.map(rowLabel).join('\n');
  return { title: `${title} (${rows.length} rows)`, output: fit(head + legend + body) };
}

export interface FileDiffArgs {
  /** Repo-relative file path (absolute paths under the root also accepted). */
  path: string;
  /** Compare against `HEAD` (default) or `Base` (merge-base with the default base branch). */
  baseline?: Baseline;
  /** Full file context instead of the default 3-line hunks. */
  full?: boolean;
}

/** `file_diff` — unified diff plus the view_policy hint for the file. */
export async function fileDiff(repo: RepoContext, args: FileDiffArgs): Promise<ToolOutput> {
  const { host, root, git } = repo;
  const rel = toRel(root, args.path);
  const title = `file_diff ${rel}`;
  if (rel === '') return { title: 'file_diff', output: 'file_diff: path is required' };

  const baseline: Baseline = args.baseline === 'Base' ? 'Base' : 'HEAD';
  const statusMap = git ? await gitStatus(host, root) : new Map<string, GitStatus>();
  const st = statusMap.get(rel);
  if (st === undefined && !(await host.exists(rel))) {
    return { title, output: `file_diff: path not found: ${rel}` };
  }

  const text = await gitFileDiff(host, root, rel, baseline, { fullContext: args.full === true });
  const pref: ChangedFileView = 'diff';
  const fd = describeFile(rel, st);
  const view = defaultMode(fd, pref);
  const modes = applicableModes(fd, pref).join(', ');
  const head = `# file_diff ${rel} baseline=${baseline} git=${git ? 'yes' : 'no'} view=${view} modes=${modes}`;
  if (text === '') {
    return { title, output: `${head}\n(no changes against ${baseline})` };
  }
  return { title, output: fit(`${head}\n${text}`) };
}

export interface FileSearchArgs {
  /** Fuzzy query (case-insensitive subsequence). */
  query: string;
}

/** `file_search` — ranked fuzzy go-to-file: `score  path`, best first. */
export async function fileSearch(repo: RepoContext, args: FileSearchArgs): Promise<ToolOutput> {
  const { host } = repo;
  const query = args.query.trim();
  if (query === '') return { title: 'file_search', output: 'file_search: empty query' };
  const files = await collectFiles(host);
  const ranked = fuzzyFilter(query, files, (p) => p).slice(0, FILE_SEARCH_LIMIT);
  const head = `# file_search "${query}" hits=${ranked.length} scanned=${files.length}`;
  if (ranked.length === 0) return { title: 'file_search', output: `${head}\n(no matches)` };
  const body = ranked.map(({ item, score }) => `${score}  ${item}`).join('\n');
  return { title: `file_search (${ranked.length} hits)`, output: fit(`${head}\n${body}`) };
}

export interface ContentSearchArgs {
  /** Literal query, ASCII case-insensitive. */
  query: string;
  /** Max matches (default 100, cap 500). */
  limit?: number;
}

/** `content_search` — one `path:line: text` row per matching line. */
export async function contentSearch(repo: RepoContext, args: ContentSearchArgs): Promise<ToolOutput> {
  const { host } = repo;
  const query = args.query.trim();
  if (query === '') return { title: 'content_search', output: 'content_search: empty query' };
  const limit = clampInt(args.limit, 1, MAX_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT);
  // core walks repo-relative paths from '' (host is already rooted there).
  const matches = await searchContent(host, '', query, { limit });
  const head = `# content_search "${query}" matches=${matches.length} limit=${limit}`;
  if (matches.length === 0) return { title: 'content_search', output: `${head}\n(no matches)` };
  const body = matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join('\n');
  return { title: `content_search (${matches.length} hits)`, output: fit(`${head}\n${body}`) };
}
