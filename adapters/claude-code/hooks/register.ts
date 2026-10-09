import type { EngineInterface, On } from 'claude-code';
import { parseFileRef } from './core/types.ts';
import { isWindowsPath, type Engine } from './host.ts';
import { PANE_ID, PANE_TITLE, renderPane, type PaneElements } from './pane.ts';
import {
  actions,
  bindEngine,
  ensureContent,
  focusRow,
  handleScroll,
  model,
  noteSize,
  openTarget,
  refresh,
  resetSession,
  scheduleRefresh,
  setFocusSide,
  setShown,
} from './model.ts';

const COMMAND = 'files';

let engine: Engine | null = null;

function engineOf($: EngineInterface, sessionCwd: string): Engine {
  return {
    cwd: () => sessionCwd,
    isWindows: isWindowsPath(sessionCwd),
    list: (path) => $.fs.list(path),
    read: (path) => $.fs.read(path),
    exists: (path) => $.fs.exists(path),
    run: (argv, init) => $.process.run(argv, init),
    after: (ms, fn) => $.clock.after(ms, fn),
    storeGet: (key) => $.store.get(key),
    storeSet: (key, value) => $.store.set(key, value),
    invalidate: () => $.ui.invalidate('ui.render'),
  };
}

async function boot($: EngineInterface): Promise<Engine> {
  if (engine !== null) return engine;
  const sessionCwd = await $.session.cwd();
  engine = engineOf($, sessionCwd);
  bindEngine(engine, sessionCwd);
  return engine;
}

/**
 * The file viewer mod: `/files [path[:line]]` opens the pane, the pane draws
 * from `model.ts`'s single state object, and every edit or shell command
 * schedules a refresh of the tree and the open file.
 */
export function register(on: On, options?: Record<string, unknown>): void {

  on('session.start', async ($, e, next) => {
    resetSession(e.cwd);
    engine = engineOf($, e.cwd);
    bindEngine(engine, e.cwd);
    try {
      await $.command.register({
        name: COMMAND,
        description: 'Open the git-aware file viewer (tree, diff, markdown, code)',
        argumentHint: '[path[:line]]',
        immediate: true,
      });
    } catch {
      // Another plugin already owns /files; leave its registration standing.
    }
    scheduleRefresh();
    return next(e);
  });

  on('command.run', { command: COMMAND }, async ($, e) => {
    await boot($);
    const ref = parseFileRef(e.args);
    await refresh();
    if (ref.path !== '') await openTarget(ref);
    const opened = (await $.ui.open({
      id: PANE_ID,
      title: PANE_TITLE,
      focus: true,
      closeOnEscape: true,
    })) as { isPlaced?: boolean } | undefined;
    if (opened?.isPlaced === false) {
      await $.ui.close({ id: PANE_ID });
      return { text: 'Files: the pane is waiting for a wider terminal.' };
    }
    setShown(true);
    return {};
  }).catch(async () => ({ text: 'file viewer: could not open the pane' }));

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e);
    await boot($);
    setShown(true);
    const elements = (await $.ui.resolve(e)) as unknown as PaneElements;
    const size = { bodyColumns: e.props.bodyColumns, bodyRows: e.props.scroll.bodyRows };
    noteSize(size);
    ensureContent();
    return renderPane(elements, model(), size, actions);
  }).catch(async ($, e) => {
    const elements = (await $.ui.resolve(e)) as unknown as PaneElements;
    return elements.Box({
      children: [elements.Text({ children: ['file viewer: this drawing failed'] })],
    });
  });

  on('ui.focus', { component: 'Pane', requestId: PANE_ID }, ($, e, next) => {
    const key = e.element;
    if (typeof key === 'string' && key.startsWith('row:')) {
      setFocusSide('tree');
      focusRow(key.slice(4));
    } else if (typeof key === 'string') {
      setFocusSide('toolbar');
    }
    return next(e);
  }).catch(($, e, next) => next(e));

  on('ui.scroll', { requestId: PANE_ID }, ($, e) => {
    handleScroll(e.by, e.bodyRows, e.pointer?.column);
    return {};
  }).catch(($, e, next) => next(e));

  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    const result = await next(e);
    setShown(false);
    return result;
  }).catch(($, e, next) => next(e));

  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell'] }, async ($, e, next) => {
    try {
      return await next(e);
    } finally {
      scheduleRefresh();
    }
  }).catch(($, e, next) => next(e));
}

