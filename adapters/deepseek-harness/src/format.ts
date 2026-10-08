/**
 * Pure text renderers for the three model tools — rows/diffs/matches in,
 * model-friendly plain text out, with explicit truncation notes.
 * No I/O here: everything is unit-testable without a filesystem.
 */
import type { Baseline, GitStatus, TreeNode } from './core/types.ts';

/** Default/max row budget for `file_tree` output. */
export const DEFAULT_TREE_ROWS = 500;
export const MAX_TREE_ROWS = 2000;
/** Character budget for `file_diff` output (model-friendly slice of the 4 MiB capture cap). */
export const DEFAULT_DIFF_CHARS = 128 * 1024;
export const MAX_DIFF_CHARS = 512 * 1024;
/** Default/max match count for `content_search` output. */
export const DEFAULT_SEARCH_LIMIT = 100;
export const MAX_SEARCH_LIMIT = 500;

/** One-character git status marker for tree rows. */
export function statusMarker(status: GitStatus): string {
  switch (status) {
    case 'Modified':
      return 'M';
    case 'Added':
      return 'A';
    case 'Deleted':
      return 'D';
    case 'Untracked':
      return '?';
  }
}

/** Directory name + trailing `/`; `[changes]` marks a dir containing changes. */
function rowLabel(row: TreeNode): string {
  const name = row.label ?? row.path.split('/').pop() ?? row.path;
  if (row.kind === 'dir') return `${name}/${row.dirDirty ? ' *' : ''}`;
  return row.status ? `${name} [${statusMarker(row.status)}]` : name;
}

export interface TreeTextOptions {
  /** Render at most this many rows (rest summarized). */
  maxRows?: number;
  /** Heading shown above the rows. */
  title?: string;
  /** Extra footer lines (e.g. "not a git repo" notes), appended after truncation. */
  notes?: string[];
}

/**
 * Render tree rows as an indented plain-text tree.
 * Legend (printed whenever a marker is used): `[M] modified  [A] added
 * `[D] deleted  `[?] untracked  `* dir contains changes`.
 */
export function formatTreeRows(rows: TreeNode[], opts: TreeTextOptions = {}): string {
  const maxRows = Math.max(1, opts.maxRows ?? DEFAULT_TREE_ROWS);
  const shown = rows.slice(0, maxRows);
  const lines: string[] = [];
  if (opts.title) lines.push(opts.title);

  for (const row of shown) {
    lines.push(`${'  '.repeat(row.depth)}${rowLabel(row)}`);
  }

  const usedMarker = shown.some((r) => r.status !== undefined || (r.kind === 'dir' && r.dirDirty));
  if (usedMarker) {
    lines.push('[M] modified  [A] added  [D] deleted  [?] untracked  * dir contains changes');
  }
  if (rows.length > shown.length) {
    lines.push(
      `… (truncated: ${shown.length} of ${rows.length} rows shown; raise max_rows or narrow path)`,
    );
  }
  for (const note of opts.notes ?? []) lines.push(note);
  return lines.join('\n');
}

/** Render a unified diff for one file with an optional truncation note. */
export function formatDiff(
  relPath: string,
  baseline: Baseline,
  text: string,
  opts: { maxChars?: number } = {},
): string {
  const maxChars = Math.max(256, opts.maxChars ?? DEFAULT_DIFF_CHARS);
  const heading = `# diff ${relPath} vs ${baseline}`;
  if (text.length === 0) return `${heading}\n(no differences)`;
  if (text.length <= maxChars) return `${heading}\n${text}`;
  return [
    heading,
    text.slice(0, maxChars),
    `… (truncated: ${maxChars} of ${text.length} characters shown; request a narrower diff)`,
  ].join('\n');
}

export interface SearchTextOptions {
  query: string;
  /** True when the search stopped at the limit (more matches may exist). */
  limitHit?: boolean;
  limit?: number;
  notes?: string[];
}

/** Render `path:line` search matches, one per line, with a limit note. */
export function formatSearch(matches: readonly { path: string; line: number; text: string }[], opts: SearchTextOptions): string {
  const lines: string[] = [];
  if (matches.length === 0) {
    lines.push(`no matches for "${opts.query}"`);
  } else {
    lines.push(`${matches.length} match(es) for "${opts.query}"`);
    for (const m of matches) lines.push(`${m.path}:${m.line}: ${m.text}`);
    if (opts.limitHit) {
      lines.push(
        `… (truncated at limit=${opts.limit ?? DEFAULT_SEARCH_LIMIT}; refine the query or raise limit)`,
      );
    }
  }
  for (const note of opts.notes ?? []) lines.push(note);
  return lines.join('\n');
}
