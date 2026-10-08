import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fileAddressFor,
  isAbsolutePath,
  relativeToWorkspace,
  encodeSegment,
} from '../src/address.ts';

test('fileAddressFor: relative path + session → session scope', () => {
  assert.equal(
    fileAddressFor('sess-1', 'D:/ws', 'src/index.ts'),
    'dsh-resource://file/session/sess-1/src/index.ts',
  );
});

test('fileAddressFor: absolute path inside workspace → session-relative', () => {
  assert.equal(
    fileAddressFor('sess-1', 'D:/ws', 'D:\\ws\\src\\x.ts'),
    'dsh-resource://file/session/sess-1/src/x.ts',
  );
});

test('fileAddressFor: absolute path outside workspace → absolute scope, leading slash dropped', () => {
  assert.equal(
    fileAddressFor('sess-1', '/home/me/proj', '/etc/hosts'),
    'dsh-resource://file/absolute/etc/hosts',
  );
});

test('fileAddressFor: Windows drive letter colon stays literal', () => {
  assert.equal(
    fileAddressFor('s1', 'D:/ws', 'C:/other/file.txt'),
    'dsh-resource://file/absolute/C:/other/file.txt',
  );
});

test('fileAddressFor: no session id falls back to absolute scope', () => {
  assert.equal(
    fileAddressFor(undefined, 'D:/ws', 'src/x.ts'),
    'dsh-resource://file/absolute/D:/ws/src/x.ts',
  );
});

test('fileAddressFor: session id is component-encoded', () => {
  assert.equal(
    fileAddressFor('a b/c', 'D:/ws', 'x.ts'),
    'dsh-resource://file/session/a%20b%2Fc/x.ts',
  );
});

test('encodeSegment keeps colon, encodes everything else', () => {
  assert.equal(encodeSegment('C:'), 'C:');
  assert.equal(encodeSegment('a b'), 'a%20b');
  assert.equal(encodeSegment('x#y'), 'x%23y');
});

test('relativeToWorkspace: descendant, self, and outside cases', () => {
  assert.equal(relativeToWorkspace('D:/ws', 'D:/ws/a/b.ts'), 'a/b.ts');
  assert.equal(relativeToWorkspace('D:/ws', 'D:/ws'), '');
  assert.equal(relativeToWorkspace('D:/ws', 'D:/other'), undefined);
  assert.equal(relativeToWorkspace('/w s', '/w s/f.txt'), 'f.txt');
  // case-insensitive drive paths (Windows)
  assert.equal(relativeToWorkspace('D:/WS', 'd:/ws/f.txt'), 'f.txt');
});

test('isAbsolutePath detects POSIX and drive paths', () => {
  assert.equal(isAbsolutePath('/x/y'), true);
  assert.equal(isAbsolutePath('D:/x'), true);
  assert.equal(isAbsolutePath('D:\\x'), true);
  assert.equal(isAbsolutePath('src/x.ts'), false);
});
