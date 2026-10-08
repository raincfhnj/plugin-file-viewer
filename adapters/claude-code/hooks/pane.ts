import type { RenderElement } from 'claude-code';
import type {
  Baseline,
  ChangedFileView,
  FileDescriptor,
  NodeKind,
  TreeNode,
  ViewMode,
} from './core/types.ts';
import { applicableModes, defaultMode } from './core/view_policy.ts';

/** The pane's id: `$.ui.open`, `ui.render`, `ui.scroll` and `ui.focus` all key on it. */
export const PANE_ID = 'file-viewer';

/** The pane's tab title. */
export const PANE_TITLE = 'Files';

/** The hard cap `Code.source` and `Markdown.text` impose on one element. */
export const TEXT_LIMIT = 10000;

/** One drawing pass: everything the pane knows about its own geometry. */
export interface PaneSize {
  bodyColumns: number;
  bodyRows: number;
}

/** The rows and columns each part of the pane may take. */
export interface Layout {
  treeColumns: number;
  treeRows: number;
  treeWindowRows: number;
  contentRows: number;
}

/** Which side of the split the tree sits on; the content takes the other. */
export type LayoutSide = 'tree-left' | 'tree-right';

/** The data the drawing reads. `model.ts` owns the instance. */
export interface Model {
  rows: readonly TreeNode[];
  selectedPath?: string;
  selectedKind?: NodeKind;
  treeStart: number;
  contentStart: number;
  contentLines: readonly string[];
  contentKind: 'none' | 'source' | 'diff';
  contentPath?: string;
  notice?: string;
  viewMode: ViewMode;
  baseline: Baseline;
  changedView: ChangedFileView;
  changedOnly: boolean;
  layoutSide: LayoutSide;
  isRepo: boolean;
  isFindOpen: boolean;
  findQuery: string;
  status: string;
}

/** The callbacks the drawing wires to its controls. */
export interface PaneActions {
  onRowPress(path: string, kind: NodeKind): void;
  onToggleFind(): void;
  onInputFind(value: string): void;
  onSubmitFind(value: string): void;
  onCycleView(): void;
  onNextChanged(): void;
  onPrevChanged(): void;
  onCycleBaseline(): void;
  onToggleChangedOnly(): void;
  onToggleLayout(): void;
  onRefresh(): void;
}

type El = (props: any) => RenderElement;

/** The elements `$.ui.resolve(e)` hands over, narrowed to what the pane draws. */
export interface PaneElements {
  Box: El;
  Text: El;
  Button: El;
  Input: El;
  Code: El;
  Markdown: El;
}

const TOOLBAR_ROWS = 1;
const STATUS_ROWS = 1;
const MIN_SIDE_ROWS = 3;

export function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/** How tall and wide each pane region may be for one `ui.render`. */
export function layoutOf(size: PaneSize): Layout {
  const sideRows = Math.max(MIN_SIDE_ROWS, size.bodyRows - TOOLBAR_ROWS - STATUS_ROWS);
  const treeRows = sideRows;
  const treeWindowRows = Math.max(1, treeRows - 2);
  const contentRows = Math.max(1, sideRows - 1);
  let treeColumns = Math.round(size.bodyColumns * 0.3);
  treeColumns = clamp(treeColumns, 16, 44);
  treeColumns = Math.min(treeColumns, Math.max(12, size.bodyColumns - 24));
  return { treeColumns, treeRows, treeWindowRows, contentRows };
}

function baseName(path: string): string {
  const at = path.lastIndexOf('/');
  return at === -1 ? path : path.slice(at + 1);
}

function statusMark(row: TreeNode): string {
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

/** One tree row: selection mark, git mark, depth indent, expansion caret, name. */
export function rowLabel(row: TreeNode, isSelected: boolean): string {
  const selection = isSelected ? '❯ ' : '  ';
  const mark = statusMark(row) + ' ';
  const indent = '  '.repeat(Math.max(0, row.depth));
  const caret = row.kind === 'dir' ? (row.expanded ? '▾ ' : '▸ ') : '';
  const name = (row.label ?? baseName(row.path)) + (row.kind === 'dir' && row.dirDirty ? '~' : '');
  return selection + mark + indent + caret + name;
}

/** Trim text to the element cap, leaving the engine's truncation note at the tail. */
export function fitText(text: string, limit = TEXT_LIMIT): string {
  if (text.length <= limit) return text;
  const note = '\n… [truncated]';
  return text.slice(0, Math.max(0, limit - note.length)) + note;
}

/** The view a file opens in, honouring a caller's override when the policy allows it. */
export function resolveMode(
  fd: FileDescriptor,
  pref: ChangedFileView,
  override?: ViewMode,
): ViewMode {
  if (fd.isDeleted) return 'diff';
  const modes = applicableModes(fd, pref);
  if (override !== undefined && modes.includes(override)) return override;
  return defaultMode(fd, pref);
}

/** The next view in the file's own cycle (`v`). */
export function cycleMode(fd: FileDescriptor, pref: ChangedFileView, current: ViewMode): ViewMode {
  const modes = fd.isDeleted
    ? applicableModes(fd, pref).filter((mode) => mode === 'diff' || mode === 'fullDiff')
    : applicableModes(fd, pref);
  if (modes.length === 0) return 'diff';
  const at = modes.indexOf(current);
  if (at === -1) return modes[0] as ViewMode;
  return modes[(at + 1) % modes.length] as ViewMode;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function isFileHeader(line: string): boolean {
  return (
    line.startsWith('diff --git') ||
    line.startsWith('index ') ||
    line.startsWith('--- ') ||
    line.startsWith('+++ ') ||
    line.startsWith('new file') ||
    line.startsWith('deleted file') ||
    line.startsWith('old mode') ||
    line.startsWith('new mode') ||
    line.startsWith('similarity index') ||
    line.startsWith('rename ') ||
    line.startsWith('Binary files') ||
    line.startsWith('\\ No newline')
  );
}

function isHunkHeader(line: string): boolean {
  return HUNK_RE.test(line);
}

function isHeaderLine(line: string): boolean {
  return isFileHeader(line) || isHunkHeader(line);
}

/** True when the text parses as unified-diff hunks, as `Code({ format: 'diff' })` needs. */
export function looksLikeDiff(text: string): boolean {
  if (!text.includes('@@')) return false;
  let hunks = 0;
  for (const line of text.split('\n')) {
    if (isHunkHeader(line)) {
      hunks += 1;
      continue;
    }
    if (line === '' || isFileHeader(line)) continue;
    if (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-')) continue;
    return false;
  }
  return hunks > 0;
}

function countLine(line: string, counts: { ctx: number; add: number; del: number }): void {
  if (line.startsWith(' ')) counts.ctx += 1;
  else if (line.startsWith('+')) counts.add += 1;
  else if (line.startsWith('-')) counts.del += 1;
  else if (line === '') counts.ctx += 1;
}

function hunkHeader(srcStart: number, tgtStart: number, counts: { ctx: number; add: number; del: number }): string {
  return `@@ -${srcStart},${counts.ctx + counts.del} +${tgtStart},${counts.ctx + counts.add} @@`;
}

/**
 * Cut `lines[from, to)` as a diff that still parses: the window's first hunk
 * header is rewritten to the line numbers and counts the slice really holds, so
 * scrolling a diff can land anywhere without `Code({ format: 'diff' })` refusing.
 */
export function sliceDiff(lines: readonly string[], from: number, to: number): string {
  const start = clamp(from, 0, lines.length);
  const end = clamp(to, start, lines.length);
  if (start === 0) return lines.slice(0, end).join('\n');

  const out: string[] = [];
  let i = start;
  while (i < end) {
    const line = lines[i] as string;
    if (isHunkHeader(line)) {
      const match = HUNK_RE.exec(line);
      const counts = { ctx: 0, add: 0, del: 0 };
      let j = i + 1;
      while (j < end && !isHeaderLine(lines[j] as string)) {
        countLine(lines[j] as string, counts);
        j += 1;
      }
      out.push(hunkHeader(Number(match?.[1] ?? 1), Number(match?.[2] ?? 1), counts));
      for (let k = i + 1; k < j; k += 1) out.push(lines[k] as string);
      i = j;
      continue;
    }
    if (isFileHeader(line)) {
      out.push(line);
      i += 1;
      continue;
    }
    let governing = -1;
    for (let k = start - 1; k >= 0; k -= 1) {
      if (isHunkHeader(lines[k] as string)) {
        governing = k;
        break;
      }
    }
    if (governing === -1) {
      for (let k = start; k < end; k += 1) out.push(lines[k] as string);
      break;
    }
    const match = HUNK_RE.exec(lines[governing] as string);
    const before = { ctx: 0, add: 0, del: 0 };
    for (let k = governing + 1; k < start; k += 1) countLine(lines[k] as string, before);
    const counts = { ctx: 0, add: 0, del: 0 };
    let j = start;
    while (j < end && !isHeaderLine(lines[j] as string)) {
      countLine(lines[j] as string, counts);
      j += 1;
    }
    out.push(
      hunkHeader(
        Number(match?.[1] ?? 1) + before.ctx + before.del,
        Number(match?.[2] ?? 1) + before.ctx + before.add,
        counts,
      ),
    );
    for (let k = start; k < j; k += 1) out.push(lines[k] as string);
    i = j;
  }
  return out.join('\n');
}

function modeLabel(mode: ViewMode): string {
  switch (mode) {
    case 'diff':
      return 'diff';
    case 'fullDiff':
      return 'full diff';
    case 'renderedMarkdown':
      return 'markdown';
    default:
      return 'code';
  }
}

function headerText(m: Model, from: number, to: number): string {
  const parts = [m.contentPath ?? '(nothing selected)', modeLabel(m.viewMode)];
  if (m.contentKind !== 'none') {
    const total = m.contentLines.length;
    parts.push(m.contentKind === 'diff' ? `${from + 1}-${to}/${total}` : `L${from + 1}-${to}/${total}`);
    if (m.contentKind === 'diff') parts.push(`vs ${m.baseline}`);
  }
  return parts.join(' · ');
}

function statusText(m: Model, first: number, last: number): string {
  const parts: string[] = [];
  if (m.rows.length === 0) parts.push('0 rows');
  else parts.push(`${first}-${last}/${m.rows.length} rows`);
  parts.push(m.isRepo ? `base ${m.baseline}` : 'no git repo');
  if (m.changedOnly) parts.push('changed only');
  if (m.status !== '') parts.push(m.status);
  return parts.join(' · ');
}

function contentBody(ui: PaneElements, m: Model, from: number, to: number): RenderElement {
  if (m.contentKind === 'none') {
    return ui.Text({ children: [m.notice ?? ''], dimColor: true, wrap: 'truncate-end' });
  }
  const visible = m.contentLines.slice(from, to);
  if (m.contentKind === 'diff') {
    const text = fitText(sliceDiff(m.contentLines, from, to));
    return looksLikeDiff(text)
      ? ui.Code({ source: text, format: 'diff', path: m.contentPath, wrap: 'truncate-end' })
      : ui.Code({ source: text, format: 'source', path: m.contentPath, startLine: from + 1, wrap: 'truncate-end' });
  }
  const text = fitText(visible.join('\n'));
  if (m.viewMode === 'renderedMarkdown') return ui.Markdown({ text });
  return ui.Code({ source: text, path: m.contentPath, startLine: from + 1, wrap: 'truncate-end' });
}

function toolbar(ui: PaneElements, m: Model, actions: PaneActions): RenderElement {
  if (m.isFindOpen) {
    return ui.Input({
      key: 'find',
      label: 'find',
      placeholder: 'file name…',
      value: m.findQuery,
      submitLabel: 'go',
      autoFocus: true,
      onInput: (value: string) => actions.onInputFind(value),
      onSubmit: (value: string) => actions.onSubmitFind(value),
    });
  }
  const key = (name: string, label: string, onPress: () => void): RenderElement =>
    ui.Button({ key: 'tb-' + name, label, hotkey: name, plain: true, onPress });
  return ui.Box({
    flexDirection: 'row',
    columnGap: 1,
    children: [
      key('f', 'find', actions.onToggleFind),
      key('v', 'view', actions.onCycleView),
      key('n', 'next', actions.onNextChanged),
      key('p', 'prev', actions.onPrevChanged),
      key('b', m.baseline === 'HEAD' ? 'base HEAD' : 'base Base', actions.onCycleBaseline),
      key('c', m.changedOnly ? 'all files' : 'changed', actions.onToggleChangedOnly),
      key('l', m.layoutSide === 'tree-left' ? 'tree|file' : 'file|tree', actions.onToggleLayout),
      key('r', 'reload', actions.onRefresh),
    ],
  });
}

/** Build the pane's element tree from the model and the size of this pass. */
export function renderPane(
  ui: PaneElements,
  m: Model,
  size: PaneSize,
  actions: PaneActions,
): RenderElement {
  const layout = layoutOf(size);
  const start = clamp(m.treeStart, 0, Math.max(0, m.rows.length - layout.treeWindowRows));
  const windowRows = m.rows.slice(start, start + layout.treeWindowRows);

  const treeChildren: RenderElement[] = windowRows.map((row) => {
    const isSelected = row.path === m.selectedPath;
    const props: Record<string, unknown> = {
      key: 'row:' + row.path,
      label: rowLabel(row, isSelected),
      plain: true,
      dimColor: row.kind === 'dir',
      onPress: () => actions.onRowPress(row.path, row.kind),
    };
    if (isSelected) props.autoFocus = true;
    return ui.Button(props);
  });
  if (treeChildren.length === 0) {
    treeChildren.push(ui.Text({ children: ['(empty)'], dimColor: true }));
  }

  const from = clamp(m.contentStart, 0, Math.max(0, m.contentLines.length));
  const to = clamp(from + layout.contentRows, from, m.contentLines.length);
  const first = m.rows.length === 0 ? 0 : start + 1;
  const last = m.rows.length === 0 ? 0 : start + windowRows.length;

  return ui.Box({
    flexDirection: 'column',
    children: [
      toolbar(ui, m, actions),
      ui.Box({
        flexDirection: m.layoutSide === 'tree-right' ? 'row-reverse' : 'row',
        columnGap: 1,
        children: [
          ui.Box({
            width: layout.treeColumns,
            height: layout.treeRows,
            borderStyle: 'single',
            flexDirection: 'column',
            children: treeChildren,
          }),
          ui.Box({
            flexDirection: 'column',
            flexGrow: 1,
            children: [
              ui.Text({ children: [headerText(m, from, to)], dimColor: true, wrap: 'truncate-end' }),
              contentBody(ui, m, from, to),
            ],
          }),
        ],
      }),
      ui.Text({ children: [statusText(m, first, last)], dimColor: true, wrap: 'truncate-end' }),
    ],
  });
}
