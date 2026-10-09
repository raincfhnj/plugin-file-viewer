/**
 * OpenCode TUI file-viewer logic — pure, node-free helpers shared by `tui.tsx`.
 *
 * Kept JSX-free and opentui-free on purpose: this file is covered by the
 * adapter tsconfig (`npx tsc -p adapters/opencode/tsconfig.json --noEmit`) and
 * by `node --test adapters/opencode/tests/*.test.ts`, while `tui.tsx` (the only
 * .tsx file, so excluded from both) only wires these helpers to the
 * TuiPluginApi: route + keymap + events + SDK client.
 *
 * Data sources (all read-only, via the SDK client the TUI already holds):
 * - tree        → `client.file.list` (recursive, `ignored` + hidden dirs skipped)
 * - change mark → `client.vcs.status` merged with `state.session.diff(sessionID)`
 * - content     → `client.file.read`
 */

/** Route registered with `api.route.register` (and its keymap mode name). */
export const VIEWER_ROUTE = 'file_viewer';
/** Keymap layer mode pushed while the viewer route owns input. */
export const VIEWER_MODE = 'file_viewer';
/** Tools whose execution auto-opens the viewer. */
export const VIEWER_TOOLS = ['file_tree', 'file_diff', 'file_search', 'content_search'] as const;
export type ViewerTool = (typeof VIEWER_TOOLS)[number];

export function isViewerTool(name: unknown): name is ViewerTool {
  return typeof name === 'string' && (VIEWER_TOOLS as readonly string[]).includes(name);
}

/** How the content pane was populated — decides what "open" resolves to. */
export type ContentKind = 'file' | 'content_search' | 'file_search' | 'output';

export interface TreeEntry {
  /** POSIX, viewer-root relative ('' never appears as an entry). */
  path: string;
  name: string;
  kind: 'file' | 'dir';
  /** 0 for direct children of the root. */
  depth: number;
  /** One status column: ' ' clean, M/A/D/? from git, '~' dir-or-session change. */
  mark: string;
}

/** Shape of one `client.file.list` row (SDK `FileNode`). */
export interface FileNodeLike {
  name: string;
  path: string;
  type: 'file' | 'directory';
  ignored?: boolean;
}

/** Shape of one `client.vcs.status` row (SDK `VcsFileStatus`). */
export interface VcsStatusLike {
  file: string;
  status?: string;
}

/** Shape of one `state.session.diff(sessionID)` row (SDK `TuiSidebarFileItem`). */
export interface SessionDiffLike {
  file: string;
}

/** Read-only access the viewer needs; `tui.tsx` builds it from `api.client`. */
export interface ViewerLoader {
  /** List one directory ('' = viewer root). */
  list(dir: string): Promise<FileNodeLike[]>;
  /** Working-tree change list (git status). */
  status(): Promise<VcsStatusLike[]>;
  /** Read one file. */
  read(path: string): Promise<{ type: string; content: string }>;
}

export interface TreeOptions {
  /** Levels below the root to include (default 6; root children are depth 0). */
  maxDepth?: number;
  /** Hard cap on returned rows (default 800). */
  maxEntries?: number;
  /** Skip rows with `ignored: true` such as node_modules (default true). */
  skipIgnored?: boolean;
}

export const DEFAULT_MAX_DEPTH = 6;
export const DEFAULT_MAX_ENTRIES = 800;

/** Backslashes → slashes, trailing separators stripped, `./` prefix removed. */
export function normalizeRel(input: string): string {
  let p = input.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  while (p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/** True when a directory row should never be descended into or shown. */
function skipDirName(name: string): boolean {
  return name === '.git' || name.startsWith('.');
}

function compareNodes(a: FileNodeLike, b: FileNodeLike): number {
  const ad = a.type === 'directory' ? 0 : 1;
  const bd = b.type === 'directory' ? 0 : 1;
  if (ad !== bd) return ad - bd;
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  if (an < bn) return -1;
  if (an > bn) return 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Depth-first tree rows: each directory is followed immediately by its
 * children, directories sort before files, and hidden/ignored paths are
 * dropped. A failing or over-long directory walk degrades to what it collected.
 */
export async function loadTree(loader: ViewerLoader, options: TreeOptions = {}): Promise<TreeEntry[]> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const skipIgnored = options.skipIgnored ?? true;
  const out: TreeEntry[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth || out.length >= maxEntries) return;
    let nodes: FileNodeLike[];
    try {
      nodes = await loader.list(dir);
    } catch {
      return;
    }
    for (const node of nodes) {
      if (out.length >= maxEntries) return;
      if (skipIgnored && node.ignored === true) continue;
      if (node.type === 'directory' && skipDirName(node.name)) continue;
      const path = normalizeRel(node.path || node.name);
      if (path === '') continue;
      out.push({
        path,
        name: node.name || path,
        kind: node.type === 'directory' ? 'dir' : 'file',
        depth,
        mark: ' ',
      });
      if (node.type === 'directory') await walk(path, depth + 1);
    }
  };

  await walk('', 0);
  return out;
}

/** Git status word → the pane's one-character mark. */
export function markFromStatus(status: string | undefined): string {
  switch (status) {
    case 'added':
      return 'A';
    case 'deleted':
      return 'D';
    case 'modified':
      return 'M';
    default:
      return '?';
  }
}

/**
 * Paint change marks onto rows: `vcs` wins (M/A/D/?), session-only changes get
 * `~`, and every directory containing a marked descendant gets `~` too.
 */
export function applyMarks(
  entries: TreeEntry[],
  vcs: readonly VcsStatusLike[],
  sessionDiff: readonly SessionDiffLike[] = [],
): TreeEntry[] {
  const marks = new Map<string, string>();
  for (const row of vcs) {
    const path = normalizeRel(row.file);
    if (path !== '') marks.set(path, markFromStatus(row.status));
  }
  for (const row of sessionDiff) {
    const path = normalizeRel(row.file);
    if (path !== '' && !marks.has(path)) marks.set(path, '~');
  }

  const out = entries.map((entry) => ({ ...entry, mark: marks.get(entry.path) ?? entry.mark }));

  // Directories inherit `~` from a marked descendant (deepest first).
  for (let i = out.length - 1; i >= 0; i--) {
    const entry = out[i];
    if (entry.kind !== 'dir' || entry.mark !== ' ') continue;
    for (let j = i + 1; j < out.length && out[j].depth > entry.depth; j++) {
      if (out[j].mark !== ' ') {
        entry.mark = '~';
        break;
      }
    }
  }
  return out;
}

/**
 * Index of `path` in a flattened tree. Falls back to the closest visible
 * ancestor directory so a target the tree has not expanded still lands near
 * the right place; returns -1 when nothing matches.
 */
export function findEntryIndex(entries: readonly TreeEntry[], path: string): number {
  const target = normalizeRel(path);
  if (target === '') return -1;
  for (let i = 0; i < entries.length; i++) if (entries[i].path === target) return i;
  const withSlash = target + '/';
  for (let i = 0; i < entries.length; i++) if (entries[i].path.startsWith(withSlash)) return i;
  let parent = target;
  for (;;) {
    const at = parent.lastIndexOf('/');
    if (at === -1) return -1;
    parent = parent.slice(0, at);
    if (parent === '') return -1;
    for (let i = 0; i < entries.length; i++) if (entries[i].path === parent) return i;
  }
}

/**
 * Resolve "enter" on one line of a result pane:
 * `content_search` rows are `path:line: text`, `file_search` rows are `score  path`.
 * Headers (`# …`), notes and non-matching text return undefined.
 */
export function parseResultLine(
  kind: ContentKind,
  line: string,
): { path: string; line?: number } | undefined {
  const text = line ?? '';
  if (text.trimStart().startsWith('#')) return undefined;
  if (kind === 'content_search') {
    const match = /^(.+?):(\d+):/.exec(text);
    if (!match) return undefined;
    const lineNo = Number(match[2]);
    if (!Number.isFinite(lineNo) || lineNo < 1) return undefined;
    const path = normalizeRel(match[1]);
    return path === '' ? undefined : { path, line: lineNo };
  }
  if (kind === 'file_search') {
    const match = /^\s*-?\d+\s+(\S.*?)\s*$/.exec(text);
    if (!match) return undefined;
    const path = normalizeRel(match[1]);
    return path === '' ? undefined : { path };
  }
  return undefined;
}

/** Clamp `value` into `[lo, hi]` (hi forced ≥ lo). */
export function clamp(value: number, lo: number, hi: number): number {
  const low = Math.min(lo, hi);
  const high = Math.max(lo, hi);
  if (!Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, Math.trunc(value)));
}

/** Scroll window of `height` rows that keeps `cursor` visible. */
export function windowSlice(total: number, cursor: number, height: number): { start: number; end: number } {
  const rows = Math.max(1, Math.trunc(height));
  const count = Math.max(0, Math.trunc(total));
  if (count <= rows) return { start: 0, end: count };
  const at = clamp(cursor, 0, count - 1);
  const start = clamp(at - Math.floor(rows / 2), 0, count - rows);
  return { start, end: start + rows };
}

/**
 * Tree rows in the server tool's `rowLabel` format (2-column selection slot,
 * status mark, 2-space-per-depth indent, dir caret, name) so the TUI pane and
 * the model-facing `file_tree` output read the same way.
 */
export function treeRows(
  entries: readonly TreeEntry[],
  cursor: number,
  height: number,
): { rows: string[]; start: number; end: number } {
  const { start, end } = windowSlice(entries.length, cursor, height);
  const rows: string[] = [];
  for (let i = start; i < end; i++) {
    const entry = entries[i];
    const slot = i === cursor ? '> ' : '  ';
    const indent = '  '.repeat(Math.max(0, entry.depth));
    const caret = entry.kind === 'dir' ? '▸ ' : '';
    rows.push(slot + entry.mark + ' ' + indent + caret + entry.name);
  }
  return { rows, start, end };
}

/** Content rows: optional `NNNN  text` line numbers, windowed by `offset`. */
export function contentRows(
  lines: readonly string[],
  offset: number,
  height: number,
  numbered: boolean,
  firstLineNo = 1,
): { rows: string[]; start: number; end: number } {
  const rows = Math.max(1, Math.trunc(height));
  const total = Math.max(0, Math.trunc(lines.length));
  const start = total === 0 ? 0 : clamp(offset, 0, Math.max(0, total - 1));
  const end = Math.min(total, start + rows);
  const width = String(Math.max(1, firstLineNo + total - 1)).length;
  const out: string[] = [];
  for (let i = start; i < end; i++) {
    out.push(numbered ? `${String(firstLineNo + i).padStart(width, ' ')}  ${lines[i]}` : lines[i]);
  }
  return { rows: out, start, end };
}

/** Cap huge file bodies so one render never carries unbounded text. */
export function capText(text: string, maxChars = 400_000): string {
  if (text.length <= maxChars) return text;
  const note = `\n… [truncated: kept ${maxChars} of ${text.length} chars]`;
  return text.slice(0, Math.max(0, maxChars - note.length)) + note;
}

/**
 * Index of the first row `enter` can resolve (headers/notes are skipped), so a
 * freshly shown result pane starts on a usable line. Returns 0 when none.
 */
export function firstResultIndex(kind: ContentKind, lines: readonly string[]): number {
  if (kind === 'file') return 0;
  for (let i = 0; i < lines.length; i++) {
    if (parseResultLine(kind, lines[i])) return i;
  }
  return 0;
}

/**
 * What a tool execution means for the viewer, decoded from a
 * `message.part.updated` event (v1 shape `{properties}`, tolerated v2-ish
 * `{data}` shape included). Returns undefined for every event we ignore.
 */
export interface ToolEventInfo {
  phase: 'running' | 'completed' | 'error';
  tool: ViewerTool;
  input: Record<string, unknown>;
  output: string;
  sessionID?: string;
}

export function decodeToolEvent(event: unknown): ToolEventInfo | undefined {
  if (event === null || typeof event !== 'object') return undefined;
  // Tolerate a wrapper envelope (`{ details }`) and the bare `{ data }` form.
  let envelope = event as { type?: unknown; properties?: unknown; data?: unknown; details?: unknown };
  for (let i = 0; i < 2 && envelope.type === undefined && envelope.details; i++) {
    envelope = envelope.details as typeof envelope;
  }
  if (envelope.type !== 'message.part.updated') return undefined;
  const props = (envelope.properties ?? envelope.data) as
    | { sessionID?: unknown; part?: unknown }
    | undefined;
  const part = props?.part as
    | { type?: unknown; tool?: unknown; sessionID?: unknown; state?: Record<string, unknown> }
    | undefined;
  if (!part || part.type !== 'tool') return undefined;
  const state = part.state;
  if (!state || typeof state !== 'object') return undefined;
  const status = state.status;
  const phase: ToolEventInfo['phase'] | undefined =
    status === 'completed' ? 'completed' : status === 'running' ? 'running' : status === 'error' ? 'error' : undefined;
  if (phase === undefined) return undefined;
  if (!isViewerTool(part.tool)) return undefined;
  const input = (state.input ?? {}) as Record<string, unknown>;
  const output = typeof state.output === 'string' ? state.output : '';
  const sessionID = typeof props?.sessionID === 'string' ? props.sessionID : undefined;
  return { phase, tool: part.tool, input, output, sessionID };
}

/** Best-effort `input.path` from a tool call (file_tree / file_diff). */
export function inputPath(input: Record<string, unknown>): string {
  const value = input.path;
  return typeof value === 'string' ? normalizeRel(value) : '';
}
