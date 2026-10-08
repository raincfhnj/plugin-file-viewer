import { expect, test } from 'claude-code/testing';
import { fitText, renderPane, rowLabel, TEXT_LIMIT, type Model, type PaneElements } from '../hooks/pane.ts';
import type { TreeNode } from '../hooks/core/types.ts';

function file(path: string, depth = 0, status?: TreeNode['status']): TreeNode {
  return { path, kind: 'file', depth, expanded: false, dirDirty: false, status };
}

function dir(path: string, depth: number, expanded: boolean, dirDirty = false): TreeNode {
  return { path, kind: 'dir', depth, expanded, dirDirty };
}

function fakeUi(): PaneElements {
  const el =
    (name: string) =>
    (props: Record<string, unknown>): never =>
      ({ element: name, ...props }) as never;
  return { Box: el('Box'), Text: el('Text'), Button: el('Button'), Input: el('Input'), Code: el('Code'), Markdown: el('Markdown') };
}

function modelWith(overrides: Partial<Model>): Model {
  return {
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
    isRepo: true,
    isFindOpen: false,
    findQuery: '',
    status: '',
    ...overrides,
  };
}

const noopActions = {
  onRowPress: () => {},
  onToggleFind: () => {},
  onInputFind: () => {},
  onSubmitFind: () => {},
  onCycleView: () => {},
  onNextChanged: () => {},
  onPrevChanged: () => {},
  onCycleBaseline: () => {},
  onToggleChangedOnly: () => {},
  onToggleLayout: () => {},
  onRefresh: () => {},
};

test('a tree row label carries selection, git mark, indent and name', () => {
  expect(rowLabel(file('src/a.ts', 1, 'Modified'), false)).toBe('  M   a.ts');
  expect(rowLabel(file('src/a.ts', 1, 'Modified'), true)).toBe('❯ M   a.ts');
  expect(rowLabel(file('README.md', 0), false)).toBe('    README.md');
  expect(rowLabel(file('new.ts', 0, 'Untracked'), false)).toBe('  ? new.ts');
  expect(rowLabel(file('gone.ts', 0, 'Deleted'), false)).toBe('  D gone.ts');
  expect(rowLabel(file('added.ts', 0, 'Added'), false)).toBe('  A added.ts');
});

test('directory rows show their expansion caret and a dirty mark', () => {
  expect(rowLabel(dir('src', 0, false), false)).toBe('    ▸ src');
  expect(rowLabel(dir('src', 0, true), false)).toBe('    ▾ src');
  expect(rowLabel(dir('assets', 0, true, true), false)).toBe('    ▾ assets~');
  expect(rowLabel(dir('deep', 1, false), false)).toBe('      ▸ deep');
});

test('truncated text ends with the engine note and fits the element cap', () => {
  const short = 'hello';
  expect(fitText(short)).toBe(short);
  const long = fitText('x'.repeat(TEXT_LIMIT + 500));
  expect(long.length <= TEXT_LIMIT).toBe(true);
  expect(long.endsWith('… [truncated]')).toBe(true);
});

interface DrawnBox {
  element: string;
  flexDirection?: string;
  children?: DrawnBox[];
  hotkey?: string;
  label?: string;
  onPress?: () => void;
}

function splitOf(m: Model): DrawnBox {
  const root = renderPane(fakeUi(), m, { bodyColumns: 120, bodyRows: 30 }, noopActions) as unknown as DrawnBox;
  return root.children?.[1] as DrawnBox;
}

test('the split keeps the tree on the left by default', () => {
  expect(splitOf(modelWith({})).flexDirection).toBe('row');
});

test('layoutSide tree-right reverses the split so the tree draws on the right', () => {
  expect(splitOf(modelWith({ layoutSide: 'tree-right' })).flexDirection).toBe('row-reverse');
});

test('the toolbar carries an l button wired to the layout toggle', () => {
  let pressed = 0;
  const actions = { ...noopActions, onToggleLayout: () => { pressed += 1; } };
  const root = renderPane(
    fakeUi(),
    modelWith({}),
    { bodyColumns: 120, bodyRows: 30 },
    actions,
  ) as unknown as DrawnBox;
  const toolbar = root.children?.[0] as DrawnBox;
  const button = toolbar.children?.find((child) => child.hotkey === 'l');
  expect(button).toBeDefined();
  expect(button?.label).toBe('tree|file');
  button?.onPress?.();
  expect(pressed).toBe(1);
});

test('the layout button label reflects the side the tree is on', () => {
  const root = renderPane(
    fakeUi(),
    modelWith({ layoutSide: 'tree-right' }),
    { bodyColumns: 120, bodyRows: 30 },
    noopActions,
  ) as unknown as DrawnBox;
  const toolbar = root.children?.[0] as DrawnBox;
  const button = toolbar.children?.find((child) => child.hotkey === 'l');
  expect(button?.label).toBe('file|tree');
});
