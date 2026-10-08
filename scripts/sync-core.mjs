#!/usr/bin/env node
// Copies core/src/*.ts into every adapter's core slot (replacing each).
//
// core/ is the single source of truth; the copies must never be hand-edited —
// rerun this script after changing core. The core files import each other with
// relative './x.ts' specifiers, so each copy keeps working unchanged next to
// the adapter's own files.
//
// *.test.ts stays out: those run under `node --test`, and a copy inside an
// adapter would also be picked up by that adapter's own test runner.
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const src = path.join(root, 'core', 'src');

/** adapter id -> core slot inside it (relative to adapters/) */
const targets = {
  'claude-code': 'hooks/core',
  opencode: 'core',
  'deepseek-harness': 'src/core',
};

const names = (await readdir(src))
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .sort();

if (names.length === 0) {
  console.error('sync-core: no core/src/*.ts files found');
  process.exit(1);
}

for (const [adapter, slot] of Object.entries(targets)) {
  const dest = path.join(root, 'adapters', adapter, ...slot.split('/'));
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  for (const name of names) {
    await copyFile(path.join(src, name), path.join(dest, name));
  }
  console.log(`sync-core: ${names.length} file(s) -> ${path.relative(root, dest)}`);
}
