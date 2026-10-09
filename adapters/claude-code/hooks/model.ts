import type { FileRef, GitStatus, Host, NodeKind, TreeNode } from './core/types.ts';
import { createTreeState, listRows, nextChanged, toggle, type TreeState } from './core/tree.ts';
import { describeFile } from './core/view_policy.ts';
import { fuzzyFilter } from './core/fuzzy.ts';
import {
  changedSet,
  currentBranch,
  defaultBaseline,
  fileDiff,
  status as gitStatus,
} from './core/git.ts';
import { createHost, type Engine } from './host.ts';
import {
  cycleMode,
  layoutOf,
  resolveMode,
  type Model,
  type PaneActions,
  type PaneSize,
} from './pane.ts';

const REDRAW_MS = 120;
const REFRESH_MS = 150;
const CONTENT_MS = 90;
const MAX_CONTENT_CHARS = 200000;
const LINE_CONTEXT = 10;
const HIDE_HIDDEN = true;
const NUL = String.fromCharCode(0);
const CONTROL = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]', 'g');

const EMPTY: Model = {
  rows: [],
  treeStart: 0,
  contentStart: 0,
  contentLines: [],
  contentKind: 'none',
  viewMode: 'syntaxContent',
  baseline: 'HEAD',
  changedView: 'diff',
  changedOnly: false,
  layoutSide: 'tree-left',
  isRepo: false,
  isFindOpen: false,
  findQuery: '',
  status: '',
  rootName: '',
  focusSide: 'toolbar',
};

let engine: Engine | null = null;
let cwd = '';
let repoRoot = '';
let isRepo = false;
let host: Host | null = null;
let tree: TreeState = createTreeState('');
let statusMap = new Map<string, GitStatus>();
/** Baseline changed-set (herdr changed_filter): fallback markers + `c` source. */
let changedMap = new Map<string, GitStatus>();
let m: Model = { ...EMPTY };
let shown = false;
let size: PaneSize = { bodyColumns: 80, bodyRows: 24 };

let refreshTimer: { cancel(): void } | null = null;
let redrawTimer: { cancel(): void } | null = null;
let contentTimer: { cancel(): void } | null = null;
let refreshing = false;
let refreshQueued = false;
let contentGeneration = 0;
let pendingLine: number | undefined;
let prefsKey = '';

export function toPosix(path: string): string {
  return path.replace(/\\/g, '/');
}

export function normalizeRel(path: string): string {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      const last = out[out.length - 1];
      if (out.length > 0 && last !== '..') out.pop();
      else out.push('..');
    } else {
      out.push(part);
    }
  }
  return out.join('/');
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');
}

function relativeFrom(base: string, target: string): string {
  const from = base.replace(/\/+$/, '');
  const to = target.replace(/\/+$/, '');
  if (to === from) return '';
  if (from !== '' && to.startsWith(from + '/')) return to.slice(from.length + 1);
  return '';
}

/**
 * Resolve a `/files` argument to a repo-root-relative POSIX path.
 * Relative arguments resolve against the session cwd; absolute ones must sit
 * under the repo root. Null when the path is outside the repository.
 */
export function resolveRepoRelPath(input: string, sessionCwd: string, root: string): string | null {
  const raw = toPosix(input.trim());
  const from = toPosix(sessionCwd);
  const base = toPosix(root);
  if (raw === '' || base === '') return null;
  if (isAbsolutePath(raw)) {
    if (raw === base) return '';
    if (raw.startsWith(base + '/')) return normalizeRel(raw.slice(base.length + 1));
    return null;
  }
  const cwdRel = relativeFrom(base, from);
  return normalizeRel(cwdRel === '' ? raw : `${cwdRel}/${raw}`);
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function sanitize(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(CONTROL, '');
}

function storeKey(name: string): string {
  return `file-viewer:${repoRoot}:${name}`;
}

export function bindEngine(next: Engine, sessionCwd: string): void {
  engine = next;
  if (sessionCwd !== '') cwd = toPosix(sessionCwd);
}

export function resetSession(sessionCwd: string): void {
  engine = null;
  cwd = sessionCwd === '' ? '' : toPosix(sessionCwd);
  repoRoot = '';
  isRepo = false;
  host = null;
  tree = createTreeState('');
  statusMap = new Map();
  changedMap = new Map();
  m = { ...EMPTY };
  shown = false;
  size = { bodyColumns: 80, bodyRows: 24 };
  refreshTimer?.cancel();
  refreshTimer = null;
  redrawTimer?.cancel();
  redrawTimer = null;
  contentTimer?.cancel();
  contentTimer = null;
  refreshing = false;
  refreshQueued = false;
  contentGeneration += 1;
  pendingLine = undefined;
  prefsKey = '';
}

export function model(): Model {
  return m;
}

export function setShown(value: boolean): void {
  shown = value;
}

function redraw(): void {
  if (!engine || redrawTimer !== null) return;
  redrawTimer = engine.after(REDRAW_MS, () => {
    redrawTimer = null;
    engine?.invalidate();
  });
}

export function scheduleRefresh(): void {
  if (!engine) return;
  refreshTimer?.cancel();
  refreshTimer = engine.after(REFRESH_MS, () => {
    refreshTimer = null;
    void refresh().catch(() => undefined);
  });
}

function ensureVisible(): void {
  const layout = layoutOf(size);
  const at = m.rows.findIndex((row) => row.path === m.selectedPath);
  let start = m.treeStart;
  if (at >= 0) {
    if (at < start) start = at;
    else if (at >= start + layout.treeWindowRows) start = at - layout.treeWindowRows + 1;
  }
  const maxStart = Math.max(0, m.rows.length - layout.treeWindowRows);
  start = start < 0 ? 0 : start > maxStart ? maxStart : start;
  if (start !== m.treeStart) m = { ...m, treeStart: start };
}

export function noteSize(next: PaneSize): void {
  size = next;
  ensureVisible();
}

async function ensureRepo(): Promise<void> {
  if (repoRoot !== '' || !engine) return;
  repoRoot = cwd === '' ? '/' : cwd;
  const probe = createHost(engine, repoRoot);
  try {
    const answer = await probe.runGit(cwd, ['rev-parse', '--show-toplevel']);
    const top = answer.stdout.trim();
    if (answer.exitCode === 0 && top !== '') {
      repoRoot = toPosix(top);
      isRepo = true;
    }
  } catch {
    isRepo = false;
  }
  host = createHost(engine, repoRoot);
  tree = createTreeState('');
  m = { ...m, rootName: baseNameOf(repoRoot === cwd ? cwd : repoRoot) };
}

function baseNameOf(path: string): string {
  const clean = path.replace(/\/+$/, '');
  const at = clean.lastIndexOf('/');
  return at === -1 ? clean : clean.slice(at + 1);
}

async function loadPrefs(): Promise<void> {
  if (!engine || prefsKey === repoRoot) return;
  prefsKey = repoRoot;
  try {
    const baseline = await engine.storeGet(storeKey('baseline'));
    if (baseline === 'HEAD' || baseline === 'Base') {
      m = { ...m, baseline };
    } else if (host && isRepo) {
      // herdr default_baseline: no stored preference → context-smart (AC-14/15).
      m = { ...m, baseline: await defaultBaseline(host, repoRoot) };
    }
    const changedOnly = await engine.storeGet(storeKey('changedOnly'));
    if (typeof changedOnly === 'boolean') m = { ...m, changedOnly };
    const changedView = await engine.storeGet(storeKey('changedView'));
    if (changedView === 'diff' || changedView === 'content') m = { ...m, changedView };
    const layout = await engine.storeGet(storeKey('layout'));
    if (layout === 'tree-left' || layout === 'tree-right') m = { ...m, layoutSide: layout };
  } catch {
    m = { ...m, status: 'preferences unavailable' };
  }
}

async function savePref(name: string, value: unknown): Promise<void> {
  try {
    await engine?.storeSet(storeKey(name), value);
  } catch {
    m = { ...m, status: 'preference not saved' };
  }
}

/** Marker/policy status for a path: working-tree status wins, baseline set fills in. */
function statusOf(path: string): GitStatus | undefined {
  return statusMap.get(path) ?? changedMap.get(path);
}

/** Track which column was touched last (herdr focus → border highlight). */
export function setFocusSide(side: Model['focusSide']): void {
  if (m.focusSide === side) return;
  m = { ...m, focusSide: side };
  redraw();
}

async function rebuildRows(): Promise<void> {
  if (!host) return;
  try {
    const rows = await listRows(host, tree, statusMap, {
      changedOnly: m.changedOnly,
      hideHidden: HIDE_HIDDEN,
      changedSet: changedMap,
    });
    m = { ...m, rows };
  } catch (err) {
    m = { ...m, rows: [], status: 'tree unavailable: ' + errorText(err) };
  }
}

export async function refresh(): Promise<void> {
  if (refreshing) {
    refreshQueued = true;
    return;
  }
  refreshing = true;
  try {
    await ensureRepo();
    if (!host) return;
    let next = new Map<string, GitStatus>();
    try {
      next = await gitStatus(host, repoRoot);
    } catch {
      next = new Map();
      m = { ...m, status: 'git unavailable' };
    }
    statusMap = next;
    await loadPrefs();
    // Baseline changed-set (herdr refresh_git_state): marker fallback + `c` source.
    try {
      changedMap = isRepo ? await changedSet(host, repoRoot, m.baseline) : new Map();
    } catch {
      changedMap = new Map();
    }
    let branch: string | undefined;
    try {
      branch = isRepo ? await currentBranch(host, repoRoot) : undefined;
    } catch {
      branch = undefined;
    }
    await rebuildRows();
    ensureVisible();
    m = { ...m, isRepo, branch };
    if (shown && m.selectedKind === 'file' && m.selectedPath !== undefined) scheduleContent();
  } catch (err) {
    m = { ...m, rows: [], status: 'refresh failed: ' + errorText(err) };
  } finally {
    refreshing = false;
    redraw();
    if (refreshQueued) {
      refreshQueued = false;
      scheduleRefresh();
    }
  }
}

function scheduleContent(): void {
  if (!engine) return;
  contentTimer?.cancel();
  const path = m.selectedPath;
  const line = pendingLine;
  pendingLine = undefined;
  contentTimer = engine.after(CONTENT_MS, () => {
    contentTimer = null;
    void loadContent(path, line).catch(() => undefined);
  });
}

async function loadContent(path: string | undefined, line: number | undefined): Promise<void> {
  if (!host || path === undefined || m.selectedPath !== path) return;
  const generation = ++contentGeneration;
  try {
    if (m.viewMode === 'diff' || m.viewMode === 'fullDiff') {
      const text = await fileDiff(host, repoRoot, path, m.baseline, {
        fullContext: m.viewMode === 'fullDiff',
      });
      if (generation !== contentGeneration) return;
      if (text.trim() === '') {
        m = {
          ...m,
          contentKind: 'none',
          contentLines: [],
          contentStart: 0,
          notice: `no changes vs ${m.baseline}`,
        };
        redraw();
        return;
      }
      const lines = sanitize(text).split('\n');
      const start =
        line === undefined ? 0 : Math.max(0, Math.min(line - 1 - LINE_CONTEXT, lines.length - 1));
      m = { ...m, contentKind: 'diff', contentLines: lines, contentStart: start, notice: undefined };
      redraw();
      return;
    }
    const text = await host.readText(path);
    if (generation !== contentGeneration) return;
    if (text.includes(NUL)) {
      m = { ...m, contentKind: 'none', contentLines: [], contentStart: 0, notice: 'binary file' };
      redraw();
      return;
    }
    const clipped = sanitize(text).slice(0, MAX_CONTENT_CHARS);
    const lines = clipped.split('\n');
    const start =
      line === undefined ? 0 : Math.max(0, Math.min(line - 1 - LINE_CONTEXT, lines.length - 1));
    m = { ...m, contentKind: 'source', contentLines: lines, contentStart: start, notice: undefined };
  } catch (err) {
    if (generation !== contentGeneration) return;
    m = {
      ...m,
      contentKind: 'none',
      contentLines: [],
      contentStart: 0,
      notice: `cannot read ${path}: ${errorText(err)}`,
      status: 'read failed',
    };
  }
  redraw();
}

export function selectPath(path: string, kind: NodeKind, line?: number): void {
  const changed = m.selectedPath !== path;
  tree = { ...tree, selected: { path, kind } };
  m = { ...m, selectedPath: path, selectedKind: kind };
  if (kind !== 'file') {
    m = {
      ...m,
      contentKind: 'none',
      contentLines: [],
      contentStart: 0,
      contentPath: undefined,
      notice: 'directory',
    };
    ensureVisible();
    redraw();
    return;
  }
  if (changed || line !== undefined) {
    const fd = describeFile(path, statusOf(path));
    const mode =
      line !== undefined && !fd.isDeleted
        ? fd.isMarkdown
          ? ('renderedMarkdown' as const)
          : ('syntaxContent' as const)
        : resolveMode(fd, m.changedView, undefined);
    m = {
      ...m,
      viewMode: mode,
      contentKind: 'none',
      contentLines: [],
      contentStart: 0,
      contentPath: path,
      notice: undefined,
    };
  }
  pendingLine = line;
  scheduleContent();
  ensureVisible();
  redraw();
}

function moveSelection(delta: number): void {
  if (m.rows.length === 0) return;
  const found = m.rows.findIndex((row) => row.path === m.selectedPath);
  const at = found < 0 ? 0 : found;
  const target = at + delta;
  const index = target < 0 ? 0 : target >= m.rows.length ? m.rows.length - 1 : target;
  const row = m.rows[index] as TreeNode;
  selectPath(row.path, row.kind);
}

export function focusRow(path: string): void {
  const at = m.rows.findIndex((row) => row.path === path);
  if (at < 0) return;
  const layout = layoutOf(size);
  const bottom = m.treeStart + layout.treeWindowRows - 1;
  if (at === bottom && at < m.rows.length - 1) m = { ...m, treeStart: m.treeStart + 1 };
  else if (at === m.treeStart && m.treeStart > 0) m = { ...m, treeStart: m.treeStart - 1 };
  const row = m.rows[at] as TreeNode;
  if (m.selectedPath !== path) selectPath(row.path, row.kind);
}

function scrollContent(by: number, contentRows: number): void {
  const maxStart = Math.max(0, m.contentLines.length - contentRows);
  const start = m.contentStart + by;
  const next = start < 0 ? 0 : start > maxStart ? maxStart : start;
  if (next !== m.contentStart) m = { ...m, contentStart: next };
  redraw();
}

export function handleScroll(by: number, bodyRows: number, pointerColumn?: number): void {
  const layout = layoutOf({ bodyColumns: size.bodyColumns, bodyRows });
  const overTree =
    pointerColumn !== undefined &&
    (m.layoutSide === 'tree-right'
      ? pointerColumn >= size.bodyColumns - layout.treeColumns
      : pointerColumn < layout.treeColumns);
  if (pointerColumn !== undefined) setFocusSide(overTree ? 'tree' : 'content');
  if (overTree) moveSelection(by);
  else scrollContent(by, layout.contentRows);
}

/** Load the selected file's content when a drawing asks for text that isn't there yet. */
export function ensureContent(): void {
  if (contentTimer !== null) return;
  if (m.selectedKind !== 'file' || m.selectedPath === undefined) return;
  if (m.contentKind !== 'none' || m.notice !== undefined || m.contentLines.length > 0) return;
  scheduleContent();
}

async function toggleDir(path: string): Promise<void> {
  tree = toggle(tree, path);
  tree = { ...tree, selected: { path, kind: 'dir' } };
  m = {
    ...m,
    selectedPath: path,
    selectedKind: 'dir',
    contentKind: 'none',
    contentLines: [],
    contentStart: 0,
    contentPath: undefined,
    notice: 'directory',
  };
  await rebuildRows();
  ensureVisible();
  redraw();
}

async function reveal(path: string): Promise<void> {
  const parts = path.split('/');
  const expanded = new Set(tree.expanded);
  let acc = '';
  for (let i = 0; i < parts.length - 1; i += 1) {
    acc = acc === '' ? (parts[i] as string) : `${acc}/${parts[i] as string}`;
    expanded.add(acc);
  }
  tree = { ...tree, expanded };
  if (m.changedOnly && !statusOf(path)) {
    m = { ...m, changedOnly: false };
    await savePref('changedOnly', false);
  }
  await rebuildRows();
}

async function submitFind(value: string): Promise<void> {
  const query = value.trim();
  m = { ...m, isFindOpen: false, findQuery: '' };
  if (query === '') {
    redraw();
    return;
  }
  const files = m.rows.filter((row) => row.kind === 'file');
  const hits = fuzzyFilter(query, files, (row) => row.path);
  const target = hits.length === 0 ? '' : (hits[0]?.item.path ?? '');
  if (target === '') {
    m = { ...m, status: `no match: ${query}` };
    redraw();
    return;
  }
  await reveal(target);
  const row = m.rows.find((candidate) => candidate.path === target);
  if (row) selectPath(row.path, row.kind);
  else m = { ...m, status: `not found: ${target}` };
  redraw();
}

async function cycleBaseline(): Promise<void> {
  m = { ...m, baseline: m.baseline === 'HEAD' ? 'Base' : 'HEAD' };
  await savePref('baseline', m.baseline);
  // herdr `b`: markers and the changed-only filter are baseline-dependent too.
  if (host && isRepo) {
    try {
      changedMap = await changedSet(host, repoRoot, m.baseline);
    } catch {
      changedMap = new Map();
    }
    await rebuildRows();
    ensureVisible();
  }
  if (m.selectedKind === 'file') {
    pendingLine = undefined;
    scheduleContent();
  }
  redraw();
}

async function toggleChangedOnly(): Promise<void> {
  m = { ...m, changedOnly: !m.changedOnly };
  await savePref('changedOnly', m.changedOnly);
  await rebuildRows();
  ensureVisible();
  redraw();
}

async function toggleLayout(): Promise<void> {
  m = { ...m, layoutSide: m.layoutSide === 'tree-left' ? 'tree-right' : 'tree-left' };
  await savePref('layout', m.layoutSide);
  redraw();
}

function cycleView(): void {
  const path = m.selectedPath;
  if (path === undefined || m.selectedKind !== 'file') return;
  const fd = describeFile(path, statusOf(path));
  m = { ...m, viewMode: cycleMode(fd, m.changedView, m.viewMode) };
  pendingLine = undefined;
  scheduleContent();
  redraw();
}

function jumpChanged(direction: 1 | -1): void {
  const target = nextChanged(m.rows as TreeNode[], m.selectedPath, direction);
  if (target === undefined) {
    m = { ...m, status: 'no changed files' };
    redraw();
    return;
  }
  const row = m.rows.find((candidate) => candidate.path === target);
  if (row) selectPath(row.path, row.kind);
}

/** Select what `/files path[:line]` asked for, opening collapsed folders on the way. */
export async function openTarget(ref: FileRef): Promise<void> {
  const rel = resolveRepoRelPath(ref.path, cwd, repoRoot);
  if (rel === null || rel === '') {
    m = { ...m, status: `outside repository: ${ref.path}` };
    redraw();
    return;
  }
  if (HIDE_HIDDEN && rel.split('/').some((part) => part.startsWith('.'))) {
    m = { ...m, status: `hidden path: ${rel}` };
    redraw();
    return;
  }
  await reveal(rel);
  const row = m.rows.find((candidate) => candidate.path === rel);
  if (!row) {
    m = { ...m, status: `not found: ${rel}` };
    redraw();
    return;
  }
  selectPath(row.path, row.kind, ref.line);
}

export const actions: PaneActions = {
  onRowPress: (path, kind) => {
    if (kind === 'dir') void toggleDir(path).catch(() => undefined);
    else selectPath(path, 'file');
  },
  onToggleFind: () => {
    m = { ...m, isFindOpen: !m.isFindOpen, findQuery: '' };
    redraw();
  },
  onInputFind: (value) => {
    m = { ...m, findQuery: value };
  },
  onSubmitFind: (value) => {
    void submitFind(value).catch(() => undefined);
  },
  onCycleView: cycleView,
  onNextChanged: () => jumpChanged(1),
  onPrevChanged: () => jumpChanged(-1),
  onCycleBaseline: () => {
    void cycleBaseline().catch(() => undefined);
  },
  onToggleChangedOnly: () => {
    void toggleChangedOnly().catch(() => undefined);
  },
  onToggleLayout: () => {
    void toggleLayout().catch(() => undefined);
  },
  onRefresh: () => {
    void refresh().catch(() => undefined);
  },
};
