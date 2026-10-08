import { expect, test } from 'claude-code/testing';
import { cycleMode, looksLikeDiff, resolveMode, sliceDiff } from '../hooks/pane.ts';
import type { FileDescriptor } from '../hooks/core/types.ts';

const changed: FileDescriptor = { path: 'src/a.ts', isMarkdown: false, isChanged: true, isDeleted: false };
const clean: FileDescriptor = { path: 'README.md', isMarkdown: true, isChanged: false, isDeleted: false };
const plain: FileDescriptor = { path: 'src/b.ts', isMarkdown: false, isChanged: false, isDeleted: false };
const deleted: FileDescriptor = { path: 'gone.ts', isMarkdown: false, isChanged: true, isDeleted: true };

test('the default view follows the view policy', () => {
  expect(resolveMode(changed, 'diff', undefined)).toBe('diff');
  expect(resolveMode(changed, 'content', undefined)).toBe('syntaxContent');
  expect(resolveMode(clean, 'diff', undefined)).toBe('renderedMarkdown');
  expect(resolveMode(clean, 'content', undefined)).toBe('renderedMarkdown');
  expect(resolveMode(plain, 'diff', undefined)).toBe('syntaxContent');
  expect(resolveMode(deleted, 'content', undefined)).toBe('diff');
  expect(resolveMode(changed, 'diff', 'fullDiff')).toBe('fullDiff');
});

test('the view cycle stays inside the modes the file allows', () => {
  expect(cycleMode(changed, 'diff', 'diff')).toBe('fullDiff');
  expect(cycleMode(changed, 'diff', 'fullDiff')).toBe('syntaxContent');
  expect(cycleMode(changed, 'diff', 'syntaxContent')).toBe('diff');
  expect(cycleMode(deleted, 'diff', 'diff')).toBe('fullDiff');
  expect(cycleMode(deleted, 'diff', 'fullDiff')).toBe('diff');
  expect(cycleMode(clean, 'diff', 'renderedMarkdown')).toBe('syntaxContent');
});

const DIFF: string[] = [
  'diff --git a/a.ts b/a.ts',
  'index 1111111..2222222 100644',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,3 +1,4 @@',
  ' line1',
  '-line2',
  '+line2b',
  '+extra',
  ' line3',
  '@@ -20,2 +21,3 @@',
  ' line20',
  '+added',
  ' line21',
];

test('a sliced diff window still parses as unified hunks', () => {
  const whole = DIFF.join('\n');
  expect(looksLikeDiff(whole)).toBe(true);
  expect(sliceDiff(DIFF, 0, DIFF.length)).toBe(whole);
  for (let from = 0; from < DIFF.length; from += 1) {
    const windowed = sliceDiff(DIFF, from, DIFF.length);
    expect(looksLikeDiff(windowed)).toBe(true);
  }
  const tail = sliceDiff(DIFF, 6, 9);
  expect(tail.startsWith('@@ ')).toBe(true);
  expect(tail).toContain('+extra');
  expect(tail).not.toContain('line20');
});

test('text that is not a diff is refused instead of drawn as one', () => {
  expect(looksLikeDiff('const x = 1')).toBe(false);
  expect(looksLikeDiff('')).toBe(false);
  expect(looksLikeDiff('@@ -1,1 +1,1 @@\nno prefix')).toBe(false);
});
