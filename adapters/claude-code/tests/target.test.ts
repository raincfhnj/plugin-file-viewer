import { expect, test } from 'claude-code/testing';
import { parseFileRef } from '../hooks/core/types.ts';
import { normalizeRel, resolveRepoRelPath, toPosix } from '../hooks/model.ts';

test('/files arguments parse as path[:line]', () => {
  expect(parseFileRef('src/x.ts:42')).toEqual({ path: 'src/x.ts', line: 42 });
  expect(parseFileRef('README.md')).toEqual({ path: 'README.md', line: undefined });
  expect(parseFileRef('')).toEqual({ path: '', line: undefined });
  expect(parseFileRef('C:/repo/a.ts:7')).toEqual({ path: 'C:/repo/a.ts', line: 7 });
  expect(parseFileRef('odd:name')).toEqual({ path: 'odd:name', line: undefined });
});

test('a /files path resolves against the session cwd inside the repository', () => {
  expect(resolveRepoRelPath('src/x.ts', '/repo', '/repo')).toBe('src/x.ts');
  expect(resolveRepoRelPath('x.ts', '/repo/src', '/repo')).toBe('src/x.ts');
  expect(resolveRepoRelPath('./a/../b.ts', '/repo', '/repo')).toBe('b.ts');
  expect(resolveRepoRelPath('../up.ts', '/repo/sub', '/repo')).toBe('up.ts');
  expect(resolveRepoRelPath('x.ts', 'D:\\repo\\src', 'D:/repo')).toBe('src/x.ts');
  expect(resolveRepoRelPath('D:/repo/src/x.ts', '/repo/src', 'D:/repo')).toBe('src/x.ts');
  expect(resolveRepoRelPath('D:/other/x.ts', '/repo', 'D:/repo')).toBe(null);
  expect(resolveRepoRelPath('', '/repo', '/repo')).toBe(null);
});

test('paths normalise to POSIX without dot segments', () => {
  expect(toPosix('a\\b\\c.ts')).toBe('a/b/c.ts');
  expect(normalizeRel('a/./b/../c.ts')).toBe('a/c.ts');
  expect(normalizeRel('/a//b/')).toBe('a/b');
});
