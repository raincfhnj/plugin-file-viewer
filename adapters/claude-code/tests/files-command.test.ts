import { expect, mock, test } from 'claude-code/testing';

const ROOT = 'D:/repo';
const NUL = String.fromCharCode(0);
const SOURCE = Array.from({ length: 60 }, (_, index) => `line${index + 1}`).join('\n');

const PANE = {
  plugin: 'file-viewer',
  component: 'Pane',
  requestId: 'file-viewer',
  viewport: { columns: 100, rows: 30 },
  props: {
    title: 'Files',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 24 },
    view: {},
  },
} as const;

function repoRelative(path: unknown): string {
  return String(path ?? '')
    .replace(/\\/g, '/')
    .replace(/^d:\/repo\/?/i, '')
    .replace(/^\//, '');
}

function gitAnswer(e: { argv: unknown }): { value: { exitCode: number; stdout: string; stderr: string } } {
  const argv = e.argv as string[];
  if (argv.includes('rev-parse')) return { value: { exitCode: 0, stdout: `${ROOT}\n`, stderr: '' } };
  if (argv.includes('status')) return { value: { exitCode: 0, stdout: ` M README.md${NUL}`, stderr: '' } };
  return { value: { exitCode: 0, stdout: '', stderr: '' } };
}

test('/files src/x.ts:42 selects the file and positions the content window', async ($, on) => {
  const clock = mock.clock(on);
  on('session.cwd', () => ({ value: ROOT }));
  on('process.run', ($, e) => gitAnswer(e));
  on('fs.list', ($, e) => {
    if (repoRelative(e.path) === 'src') {
      return { value: [{ name: 'x.ts', kind: 'file', size: SOURCE.length, isLink: false }] };
    }
    return {
      value: [
        { name: 'src', kind: 'dir', size: 0, isLink: false },
        { name: 'README.md', kind: 'file', size: 8, isLink: false },
      ],
    };
  });
  on('fs.read', () => ({ value: SOURCE }));
  on('store.get', () => ({ value: undefined }));
  on('store.set', () => ({ value: undefined }));
  const opened: Array<Record<string, unknown>> = [];
  on('ui.open', ($, e) => {
    opened.push({ ...e });
    return { value: { isPlaced: true } } as never;
  });
  on('ui.close', () => ({ value: undefined }));

  const answer = await $.command.run({ command: 'files', args: 'src/x.ts:42' } as never);

  expect(answer).toEqual({});
  expect(opened.length).toBe(1);
  expect(opened[0]?.id).toBe('file-viewer');
  expect(opened[0]?.title).toBe('Files');
  expect(opened[0]?.focus).toBe(true);
  expect(opened[0]?.closeOnEscape).toBe(true);

  await clock.advance(200);

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  expect(await ui.find({ key: 'row:src' })).toBeDefined();
  expect(await ui.find({ key: 'row:README.md' })).toBeDefined();
  const selected = await ui.find({ key: 'row:src/x.ts' });
  expect(selected).toBeDefined();
  expect((selected as { props?: { label?: string } }).props?.label).toBe('❯     x.ts');
  expect(await ui.find({ type: 'Text', text: /src\/x\.ts · code · L32-52\/60/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /1-3\/3 rows · base HEAD/ })).toBeDefined();
  await ui.unmount();
});

test('/files without arguments opens the pane on the repository tree', async ($, on) => {
  const clock = mock.clock(on);
  on('session.cwd', () => ({ value: ROOT }));
  on('process.run', ($, e) => gitAnswer(e));
  on('fs.list', () => ({
    value: [{ name: 'README.md', kind: 'file', size: 8, isLink: false }],
  }));
  on('fs.read', () => ({ value: '# hi' }));
  on('store.get', () => ({ value: undefined }));
  on('store.set', () => ({ value: undefined }));
  const opened: Array<Record<string, unknown>> = [];
  on('ui.open', ($, e) => {
    opened.push({ ...e });
    return { value: { isPlaced: true } } as never;
  });
  on('ui.close', () => ({ value: undefined }));

  const answer = await $.command.run({ command: 'files', args: '' } as never);
  await clock.advance(200);

  expect(answer).toEqual({});
  expect(opened.length).toBe(1);
  expect(opened[0]?.id).toBe('file-viewer');
  expect(opened[0]?.focus).toBe(true);

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  expect(await ui.find({ key: 'row:README.md' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /\(nothing selected\)/ })).toBeDefined();
  await ui.unmount();
});

test('a pane that will not place is withdrawn again', async ($, on) => {
  mock.clock(on);
  on('session.cwd', () => ({ value: ROOT }));
  on('process.run', ($, e) => gitAnswer(e));
  on('fs.list', () => ({ value: [] }));
  on('fs.read', () => ({ value: '' }));
  on('store.get', () => ({ value: undefined }));
  on('store.set', () => ({ value: undefined }));
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'too narrow' } }) as never);
  const closed: Array<Record<string, unknown>> = [];
  on('ui.close', ($, e) => {
    closed.push({ ...e });
    return { value: undefined };
  });

  const answer = await $.command.run({ command: 'files', args: '' } as never);

  expect(closed.length).toBe(1);
  expect(closed[0]?.id).toBe('file-viewer');
  expect(typeof answer.text).toBe('string');
});

test('toolbar buttons persist preferences and drive the find field', async ($, on) => {
  const clock = mock.clock(on);
  on('session.cwd', () => ({ value: ROOT }));
  on('process.run', ($, e) => gitAnswer(e));
  on('fs.list', ($, e) => {
    if (repoRelative(e.path) === 'src') {
      return { value: [{ name: 'x.ts', kind: 'file', size: SOURCE.length, isLink: false }] };
    }
    return {
      value: [
        { name: 'src', kind: 'dir', size: 0, isLink: false },
        { name: 'README.md', kind: 'file', size: 8, isLink: false },
      ],
    };
  });
  on('fs.read', () => ({ value: SOURCE }));
  on('store.get', () => ({ value: undefined }));
  const saved: Array<{ key: string; value: unknown }> = [];
  on('store.set', ($, e) => {
    saved.push({ key: String(e.key), value: e.value });
    return { value: undefined };
  });
  on('ui.open', () => ({ value: { isPlaced: true } }) as never);
  on('ui.close', () => ({ value: undefined }));

  await $.command.run({ command: 'files', args: 'src/x.ts' } as never);
  await clock.advance(200);

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  expect(await ui.find({ key: 'tb-b' })).toBeDefined();

  await ui.press({ key: 'tb-b' });
  await clock.advance(300);
  expect(saved.some((entry) => entry.key.endsWith(':baseline') && entry.value === 'Base')).toBe(true);

  await ui.press({ key: 'tb-c' });
  await clock.advance(300);
  expect(saved.some((entry) => entry.key.endsWith(':changedOnly') && entry.value === true)).toBe(true);
  const changed = await ui.find({ key: 'row:README.md' });
  expect(changed).toBeDefined();
  expect((changed as { props?: { label?: string } }).props?.label).toBe('  M README.md');

  await ui.press({ key: 'tb-f' });
  await clock.advance(300);
  expect(await ui.find({ key: 'find' })).toBeDefined();

  await ui.input({ key: 'find', text: 'readme' });
  await clock.advance(300);
  expect(await ui.find({ type: 'Text', text: /README\.md · diff/ })).toBeDefined();
  await ui.unmount();
});
