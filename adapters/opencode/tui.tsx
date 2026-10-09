/** @jsxImportSource @opentui/solid */
/**
 * OpenCode v1 TUI plugin — the file-viewer pane (`tui.json(c)` entry, id
 * `file-viewer`). Loader notes (see README "loader 坑"):
 *
 * - the file MUST be `.tsx`: opencode's Solid transform only loads `.jsx/.tsx`
 *   files, so a `.ts` file would keep its JSX and fail to import;
 * - the `@jsxImportSource` pragma + `solid-js` / `@opentui/solid` bare imports
 *   are bridged to the host's own copies for file-path plugins (never bundled),
 *   which is what keeps Solid reactivity on one graph;
 * - `@opencode-ai/plugin/tui` is imported type-only (erased before runtime);
 * - file-path TUI modules must export `{ id, tui }` (no `server` export).
 *
 * Every line appends to `%TEMP%/opencode-file-viewer-tui.log` so a silent load
 * failure is at least visible outside the alternate screen.
 */
import { appendFileSync } from 'node:fs';
import { createSignal, onCleanup } from 'solid-js';
import { useTerminalDimensions } from '@opentui/solid';
import type { TuiPluginApi, TuiPluginModule } from '@opencode-ai/plugin/tui';
import {
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_ENTRIES,
  VIEWER_MODE,
  VIEWER_ROUTE,
  applyMarks,
  capText,
  clamp,
  contentRows,
  decodeToolEvent,
  findEntryIndex,
  inputPath,
  loadTree,
  normalizeRel,
  parseResultLine,
  treeRows,
  windowSlice,
  type ContentKind,
  type SessionDiffLike,
  type ToolEventInfo,
  type TreeEntry,
  type ViewerLoader,
  type VcsStatusLike,
} from './viewer.ts';

const TRACE_FILE = `${process.env.TEMP ?? process.env.TMP ?? '/tmp'}/opencode-file-viewer-tui.log`;

function trace(line: string): void {
  try {
    appendFileSync(TRACE_FILE, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // A debug log must never take the TUI down.
  }
}

trace('module loaded');

type Focus = 'tree' | 'content';

interface Pane {
  mode: 'file' | 'text';
  kind: ContentKind;
  path: string;
  lines: string[];
  /** Line number of `lines[0]` when the pane shows a file. */
  line0: number;
  label: string;
  note: string;
}

const EMPTY_PANE: Pane = {
  mode: 'text',
  kind: 'output',
  path: '',
  lines: [],
  line0: 1,
  label: '(nothing open yet)',
  note: 'ctrl+g opens the viewer',
};

const PREVIEW_DELAY_MS = 120;
const PAGE = 15;

/** hey-api result → payload, with the server error surfaced as a throw. */
function dataOf<T>(res: { data?: T; error?: unknown }): T {
  const error = (res as { error?: unknown }).error;
  if (error !== undefined && error !== null) {
    const message =
      typeof error === 'string'
        ? error
        : ((error as { data?: { message?: string }; message?: string }).data?.message ??
          (error as { message?: string }).message ??
          'request failed');
    throw new Error(message);
  }
  const data = (res as { data?: T }).data;
  if (data === undefined || data === null) throw new Error('empty response');
  return data;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstResultLine(kind: ContentKind, text: string): { path: string; line?: number } | undefined {
  for (const line of text.split(/\r?\n/)) {
    const hit = parseResultLine(kind, line);
    if (hit) return hit;
  }
  return undefined;
}

const tui = async (api: TuiPluginApi): Promise<void> => {
  trace('tui() start');

  const [entries, setEntries] = createSignal<TreeEntry[]>([]);
  const [cursor, setCursor] = createSignal(0);
  const [focus, setFocus] = createSignal<Focus>('tree');
  const [pane, setPane] = createSignal<Pane>(EMPTY_PANE);
  const [contentCursor, setContentCursor] = createSignal(0);
  const [source, setSource] = createSignal('manual');
  const [note, setNote] = createSignal('ctrl+g or /fileviewer opens the viewer');
  const [busy, setBusy] = createSignal('');

  let sessionID: string | undefined;
  let treeGen = 0;
  let readGen = 0;
  let booted = false;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;

  const directory = (): string => api.state.path.directory || process.cwd();

  const loader: ViewerLoader = {
    async list(dir) {
      return dataOf(await api.client.file.list({ path: dir === '' ? '.' : dir, directory: directory() }));
    },
    async status() {
      try {
        return dataOf(await api.client.vcs.status({ directory: directory() })) as VcsStatusLike[];
      } catch {
        return [];
      }
    },
    async read(path) {
      return dataOf(await api.client.file.read({ path, directory: directory() }));
    },
  };

  function sessionDiff(): SessionDiffLike[] {
    if (!sessionID) return [];
    try {
      return [...api.state.session.diff(sessionID)];
    } catch {
      return [];
    }
  }

  function fail(where: string, error: unknown): void {
    const message = errorMessage(error);
    trace(`${where} failed: ${message}`);
    setNote(`${where} failed: ${message}`);
    api.ui.toast({ variant: 'error', title: 'File viewer', message: `${where}: ${message}`, duration: 4000 });
  }

  /** Rebuild the tree from `file.list`, then paint git + session change marks. */
  async function refreshTree(select?: string): Promise<void> {
    const gen = ++treeGen;
    setBusy('loading tree…');
    try {
      const rows = await loadTree(loader, { maxDepth: DEFAULT_MAX_DEPTH, maxEntries: DEFAULT_MAX_ENTRIES });
      let vcs: VcsStatusLike[] = [];
      try {
        vcs = await loader.status();
      } catch {
        vcs = [];
      }
      if (gen !== treeGen) return;
      const marked = applyMarks(rows, vcs, sessionDiff());
      setEntries(marked);
      const target = select ? findEntryIndex(marked, select) : -1;
      setCursor(target >= 0 ? target : clamp(cursor(), 0, Math.max(0, marked.length - 1)));
      setNote(`${marked.length} entries${vcs.length ? ` · ${vcs.length} changed` : ''}`);
      trace(`tree ready: ${marked.length} entries`);
    } catch (error) {
      if (gen === treeGen) fail('file_tree', error);
    } finally {
      if (gen === treeGen) setBusy('');
    }
  }

  async function ensureTree(): Promise<void> {
    if (entries().length === 0) await refreshTree();
  }

  function selectPath(path: string): void {
    const index = findEntryIndex(entries(), path);
    if (index >= 0) setCursor(index);
  }

  /** Show a file body in the content pane (binary/oversized bodies degrade). */
  async function openFile(path: string, line?: number): Promise<void> {
    const target = normalizeRel(path);
    if (target === '') return;
    const gen = ++readGen;
    setPane({ mode: 'file', kind: 'file', path: target, lines: [], line0: 1, label: target, note: 'loading…' });
    setContentCursor(Math.max(0, (line ?? 1) - 1));
    try {
      const file = await loader.read(target);
      if (gen !== readGen) return;
      if (file.type !== 'text') {
        setPane({ ...EMPTY_PANE, mode: 'text', kind: 'file', path: target, label: target, note: `binary file (${file.type}) — not shown` });
        return;
      }
      const text = capText(file.content);
      const lines = text.split(/\r?\n/);
      const empty = text.trim() === '';
      setPane({
        mode: 'file',
        kind: 'file',
        path: target,
        lines,
        line0: 1,
        label: target,
        note: empty ? 'empty or unreadable' : `${lines.length} lines`,
      });
      setContentCursor(clamp((line ?? 1) - 1, 0, Math.max(0, lines.length - 1)));
    } catch (error) {
      if (gen !== readGen) return;
      setPane({ ...EMPTY_PANE, mode: 'text', kind: 'file', path: target, label: target, note: `read failed: ${errorMessage(error)}` });
      trace(`read failed: ${errorMessage(error)}`);
    }
  }

  /** Show a tool result (diff / search rows) verbatim in the content pane. */
  function showResult(kind: ContentKind, text: string, label: string): void {
    const body = text.trim() === '' ? '(no output)' : text;
    const hint =
      kind === 'output'
        ? 'h/l switch pane · enter on a tree row opens that file'
        : 'enter opens the file on the first visible row';
    setPane({ mode: 'text', kind, path: '', lines: body.split(/\r?\n/), line0: 1, label, note: hint });
    setContentCursor(0);
    setFocus('content');
  }

  function schedulePreview(): void {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      previewTimer = undefined;
      void previewCursor();
    }, PREVIEW_DELAY_MS);
  }

  /** Follow the tree cursor with the file body (skipped for directories). */
  async function previewCursor(): Promise<void> {
    if (focus() !== 'tree') return;
    const entry = entries()[cursor()];
    if (!entry || entry.kind !== 'file') return;
    await openFile(entry.path);
  }

  function move(delta: number): void {
    if (focus() === 'tree') {
      const total = entries().length;
      if (total === 0) return;
      setCursor((at) => clamp(at + delta, 0, total - 1));
      schedulePreview();
      return;
    }
    const total = pane().lines.length;
    if (total === 0) return;
    setContentCursor((at) => clamp(at + delta, 0, total - 1));
  }

  function page(direction: number): void {
    move(direction * PAGE);
  }

  function switchFocus(next: Focus): void {
    setFocus(next);
    if (next === 'tree') schedulePreview();
  }

  /** Enter: open the selected tree file, or the file behind a result row. */
  async function activate(): Promise<void> {
    if (focus() === 'tree') {
      const entry = entries()[cursor()];
      if (!entry) return;
      if (entry.kind === 'dir') return;
      await openFile(entry.path);
      return;
    }
    const current = pane();
    if (current.mode !== 'text') return;
    const hit = parseResultLine(current.kind, current.lines[contentCursor()] ?? '');
    if (!hit) return;
    selectPath(hit.path);
    await openFile(hit.path, hit.line);
    setFocus('content');
  }

  function openViewer(nextSource: string): void {
    setSource(nextSource);
    api.route.navigate(VIEWER_ROUTE, { source: nextSource });
  }

  async function manualOpen(): Promise<void> {
    openViewer('manual');
    await ensureTree();
    await previewCursor();
  }

  /** The whole auto-open chain: tool event → state → route.navigate. */
  async function onToolEvent(info: ToolEventInfo): Promise<void> {
    if (info.sessionID) sessionID = info.sessionID;
    const target = inputPath(info.input);

    if (info.phase === 'running') {
      setNote(`running ${info.tool}…`);
      openViewer(info.tool);
      return;
    }
    if (info.phase === 'error') {
      setNote(`${info.tool} failed`);
      api.ui.toast({ variant: 'error', title: 'File viewer', message: `${info.tool} failed`, duration: 3000 });
      openViewer(info.tool);
      return;
    }

    setSource(info.tool);
    try {
      switch (info.tool) {
        case 'file_tree': {
          await refreshTree(target || undefined);
          setFocus('tree');
          setNote(`file_tree${target ? ` ${target}` : ''} — tree refreshed`);
          break;
        }
        case 'file_diff': {
          await ensureTree();
          selectPath(target);
          showResult('output', info.output, target || 'file_diff');
          setNote(target ? `file_diff ${target} — diff shown, enter opens the file` : 'file_diff');
          break;
        }
        case 'file_search': {
          await ensureTree();
          showResult('file_search', info.output, 'file_search results');
          const first = firstResultLine('file_search', info.output);
          if (first) selectPath(first.path);
          break;
        }
        case 'content_search': {
          await ensureTree();
          showResult('content_search', info.output, 'content_search results');
          const first = firstResultLine('content_search', info.output);
          if (first) selectPath(first.path);
          break;
        }
      }
    } catch (error) {
      fail(info.tool, error);
    }
    openViewer(info.tool);
    trace(`${info.tool} completed`);
  }

  const off = api.event.on('message.part.updated', (event) => {
    const info = decodeToolEvent(event);
    if (!info) return;
    void onToolEvent(info);
  });
  trace(`subscribed: ${off ? 'ok' : 'missing'}`);

  api.keymap.registerLayer({
    commands: [
      {
        name: 'file_viewer.show',
        title: 'File viewer',
        category: 'File viewer',
        desc: 'Open the file tree and content pane',
        namespace: 'palette',
        slashName: 'fileviewer',
        suggested: true,
        run() {
          void manualOpen();
        },
      },
    ],
    bindings: [{ key: 'ctrl+g', cmd: 'file_viewer.show', desc: 'Open file viewer' }],
  });

  api.keymap.registerLayer({
    mode: VIEWER_MODE,
    commands: [
      { name: 'file_viewer.down', title: 'Viewer: next row', run() { move(1); } },
      { name: 'file_viewer.up', title: 'Viewer: previous row', run() { move(-1); } },
      { name: 'file_viewer.page_down', title: 'Viewer: page down', run() { page(1); } },
      { name: 'file_viewer.page_up', title: 'Viewer: page up', run() { page(-1); } },
      { name: 'file_viewer.content', title: 'Viewer: focus content', run() { switchFocus('content'); } },
      { name: 'file_viewer.tree', title: 'Viewer: focus tree', run() { switchFocus('tree'); } },
      { name: 'file_viewer.open', title: 'Viewer: open row', run() { void activate(); } },
      { name: 'file_viewer.close', title: 'Viewer: back to chat', run() { api.route.navigate('home'); } },
    ],
    bindings: [
      { key: 'j', cmd: 'file_viewer.down', desc: 'Next row' },
      { key: 'down', cmd: 'file_viewer.down', desc: 'Next row' },
      { key: 'k', cmd: 'file_viewer.up', desc: 'Previous row' },
      { key: 'up', cmd: 'file_viewer.up', desc: 'Previous row' },
      { key: 'pagedown', cmd: 'file_viewer.page_down', desc: 'Page down' },
      { key: 'pageup', cmd: 'file_viewer.page_up', desc: 'Page up' },
      { key: 'l', cmd: 'file_viewer.content', desc: 'Focus content' },
      { key: 'right', cmd: 'file_viewer.content', desc: 'Focus content' },
      { key: 'h', cmd: 'file_viewer.tree', desc: 'Focus tree' },
      { key: 'left', cmd: 'file_viewer.tree', desc: 'Focus tree' },
      { key: 'enter', cmd: 'file_viewer.open', desc: 'Open row' },
      { key: 'escape', cmd: 'file_viewer.close', desc: 'Back to chat' },
      { key: 'ctrl+g', cmd: 'file_viewer.show', desc: 'Reopen file viewer' },
    ],
  });

  api.lifecycle.onDispose(() => {
    if (previewTimer) clearTimeout(previewTimer);
  });

  const Viewer = (): unknown => {
    const pop = api.mode.push(VIEWER_MODE);
    onCleanup(pop);

    if (!booted) {
      booted = true;
      void ensureTree().then(() => previewCursor());
    }

    const dim = useTerminalDimensions();
    const width = dim().width;
    const height = dim().height;
    const treeWidth = Math.max(18, Math.min(64, Math.floor(width * 0.36)));
    const textHeight = Math.max(3, height - 5);
    const theme = api.theme.current;

    const rows = entries();
    const at = cursor();
    const tree = treeRows(rows, at, Math.max(1, textHeight - 1));
    const current = pane();
    const contentWindow = windowSlice(current.lines.length, contentCursor(), Math.max(1, textHeight - 1));
    const content = contentRows(
      current.lines,
      contentWindow.start,
      Math.max(1, textHeight - 1),
      current.mode === 'file',
      current.line0,
    );
    const treeActive = focus() === 'tree';
    const header = `${source()} · ${focus()} · ${rows.length ? `${at + 1}/${rows.length}` : 'empty'}`;
    const footer = busy() || note();

    return (
      <box
        width={width}
        height={height}
        flexDirection="column"
        backgroundColor={theme.background}
        flexShrink={0}
      >
        <box
          height={1}
          flexDirection="row"
          justifyContent="space-between"
          paddingLeft={1}
          paddingRight={1}
          flexShrink={0}
        >
          <text fg={theme.accent}>File viewer</text>
          <text fg={theme.textMuted}>{header}</text>
        </box>

        <box flexDirection="row" flexGrow={1} width="100%">
          <box
            width={treeWidth}
            flexGrow={0}
            flexShrink={0}
            flexDirection="column"
            border
            borderColor={treeActive ? theme.borderActive : theme.border}
            backgroundColor={theme.backgroundPanel}
            paddingLeft={1}
            paddingRight={1}
          >
            <box height={1} flexShrink={0}>
              <text fg={treeActive ? theme.primary : theme.textMuted}>
                {`TREE${rows[at] ? ` · ${rows[at].path}` : ''}`}
              </text>
            </box>
            <text fg={theme.text}>{tree.rows.join('\n') || '(empty — ctrl+g reloads)'}</text>
          </box>

          <box
            flexGrow={1}
            flexDirection="column"
            border
            borderColor={treeActive ? theme.border : theme.borderActive}
            backgroundColor={theme.backgroundPanel}
            paddingLeft={1}
            paddingRight={1}
          >
            <box height={1} flexShrink={0}>
              <text fg={treeActive ? theme.textMuted : theme.primary}>
                {`CONTENT · ${current.label}`}
              </text>
            </box>
            <text fg={theme.text}>{content.rows.join('\n') || `(${current.note || 'empty'})`}</text>
          </box>
        </box>

        <box height={1} paddingLeft={1} paddingRight={1} flexShrink={0}>
          <text fg={busy() ? theme.warning : theme.textMuted}>
            {footer} · j/k move · enter open · ← → pane · ctrl+g viewer · esc home
          </text>
        </box>
      </box>
    );
  };

  api.route.register([{ name: VIEWER_ROUTE, render: () => Viewer() }]);
  trace('registered route + keymap + event');
  trace('tui() done');

  try {
    if (!api.kv.get<boolean>('file_viewer.hinted', false)) {
      api.kv.set('file_viewer.hinted', true);
      api.ui.toast({ variant: 'info', title: 'File viewer', message: 'ctrl+g or /fileviewer opens the file viewer', duration: 4000 });
    }
  } catch {
    // The one-shot hint is best-effort; never fail init over it.
  }
};

const plugin: TuiPluginModule & { id: string } = {
  id: 'file-viewer',
  tui,
};

export default plugin;
