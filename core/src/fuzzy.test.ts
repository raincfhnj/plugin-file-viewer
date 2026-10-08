import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyFilter, fuzzyScore } from './fuzzy.ts';

test('empty pattern scores 0 but filters to no results (fuzzy.rs AC-2)', () => {
  assert.equal(fuzzyScore('', 'src/main.ts'), 0);
  assert.deepEqual(fuzzyFilter('', ['a.ts', 'b.ts'], (s) => s), []);
});

test('subsequence matching is case-insensitive (fuzzy.rs AC-3)', () => {
  assert.notEqual(fuzzyScore('app', 'src/App.rs'), undefined);
  assert.notEqual(fuzzyScore('APP', 'src/app.rs'), undefined);
  assert.equal(fuzzyScore('app', 'README.md'), undefined);
});

test('non-subsequence does not match', () => {
  assert.equal(fuzzyScore('xyz', 'src/main.rs'), undefined);
  assert.equal(fuzzyScore('zzzzz', 'src/main.rs'), undefined);
  assert.equal(fuzzyScore('abcdef', 'abc'), undefined, 'pattern longer than target');
});

test('case folding is ASCII-only (fuzzy.rs to_ascii_lowercase)', () => {
  assert.notEqual(fuzzyScore('ó', 'Mód'), undefined, 'non-ASCII compares exactly');
  assert.equal(fuzzyScore('Ó', 'Mód'), undefined, 'Unicode upper does not fold');
});

test('exact match outranks the same pattern as a prefix of a longer path', () => {
  const exact = fuzzyScore('tree.ts', 'tree.ts');
  const prefix = fuzzyScore('tree.ts', 'docs/tree.ts');
  assert.notEqual(exact, undefined);
  assert.notEqual(prefix, undefined);
  assert.ok(exact! > prefix!, `exact ${exact} should beat prefix ${prefix}`);
});

test('a prefix match outranks the same characters later in the target', () => {
  const prefix = fuzzyScore('src', 'src/a.ts');
  const later = fuzzyScore('src', 'lib/src/a.ts');
  assert.notEqual(prefix, undefined);
  assert.notEqual(later, undefined);
  assert.ok(prefix! > later!, `prefix ${prefix} should beat mid-path ${later}`);
});

test('path-segment matches: subsequence crosses separators', () => {
  assert.notEqual(fuzzyScore('stts', 'src/tree.ts'), undefined, 'spans src + tree + ts');
  assert.notEqual(fuzzyScore('tv', 'src/tree.vue'), undefined, 't in tree, v in vue');
  assert.equal(fuzzyScore('tv', 'src/tree.ts'), undefined, 'no v in src/tree.ts');
});

test('boundary hits beat plain hits at the same length', () => {
  const boundary = fuzzyScore('tree', 'src/tree.ts');
  const plain = fuzzyScore('tree', 'mytree.ts');
  assert.notEqual(boundary, undefined);
  assert.notEqual(plain, undefined);
  assert.ok(boundary! > plain!, `boundary ${boundary} should beat plain ${plain}`);
});

test('basename hit ranks before a directory-only hit (fuzzy.rs AC-4)', () => {
  // "src/app.rs": "app" lands in the basename; "apple/x.rs" only matches directory chars.
  const basename = fuzzyScore('app', 'src/app.rs');
  const dirOnly = fuzzyScore('app', 'apple/x.rs');
  assert.notEqual(basename, undefined);
  assert.notEqual(dirOnly, undefined);
  assert.ok(
    basename! > dirOnly!,
    `basename ${basename} must outrank directory-only ${dirOnly}`,
  );
  for (const order of [
    ['src/app.rs', 'apple/x.rs'],
    ['apple/x.rs', 'src/app.rs'],
  ]) {
    const ranked = fuzzyFilter('app', order, (s) => s).map((r) => r.item);
    assert.deepEqual(ranked, ['src/app.rs', 'apple/x.rs'], `input order ${order.join(', ')}`);
  }
});

test('shorter path wins ties at equal quality', () => {
  const short = fuzzyScore('z', 'z.ts');
  const long = fuzzyScore('z', 'zzzzzz.ts');
  assert.notEqual(short, undefined);
  assert.notEqual(long, undefined);
  assert.ok(short! > long!, `shorter ${short} should beat longer ${long}`);
});

test('fuzzyFilter drops non-matches and sorts by score descending', () => {
  const items = ['src/app.rs', 'app.rs', 'apple/x.rs', 'README.md'];
  const ranked = fuzzyFilter('app', items, (s) => s);
  assert.deepEqual(
    ranked.map((r) => r.item),
    ['app.rs', 'src/app.rs', 'apple/x.rs'],
  );
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i - 1].score >= ranked[i].score, 'scores must be non-increasing');
  }
});

test('equal scores keep the original item order (stable)', () => {
  const items = ['x/a.ts', 'y/a.ts'];
  const forward = fuzzyFilter('a', items, (s) => s).map((r) => r.item);
  assert.deepEqual(forward, ['x/a.ts', 'y/a.ts'], 'same scores, input order preserved');
  const reversed = fuzzyFilter('a', [...items].reverse(), (s) => s).map((r) => r.item);
  assert.deepEqual(reversed, ['y/a.ts', 'x/a.ts']);
});

test('fuzzyFilter works over object items via the key function', () => {
  const rows = [{ path: 'src/tree.ts' }, { path: 'test.ts' }, { path: 'nope.rs' }];
  const ranked = fuzzyFilter('t', rows, (r) => r.path);
  assert.deepEqual(
    ranked.map((r) => r.item.path),
    ['test.ts', 'src/tree.ts'],
  );
});

test('scoring is deterministic across runs', () => {
  const items = ['src/app.rs', 'apple/x.rs'];
  assert.deepEqual(fuzzyFilter('app', items, (s) => s), fuzzyFilter('app', items, (s) => s));
});
