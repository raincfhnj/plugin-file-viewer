#!/usr/bin/env node
// Copies core/src/*.ts into adapters/claude-code/hooks/core/ (replacing it).
//
// core/ is the single source of truth; the copy under hooks/ must never be
// hand-edited — rerun this script after changing core. The core files import
// each other with relative './x.ts' specifiers, so the copy keeps working
// unchanged next to the adapter's own files.
//
// *.test.ts stays out: those run under `node --test core/`, and a copy under
// hooks/ would also be picked up by `claude plugin test`, which has no
// node:test.
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const src = path.join(root, 'core', 'src');
const dest = path.join(root, 'adapters', 'claude-code', 'hooks', 'core');

const names = (await readdir(src))
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .sort();

if (names.length === 0) {
  console.error('sync-core: no core/src/*.ts files found');
  process.exit(1);
}

await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });
for (const name of names) {
  await copyFile(path.join(src, name), path.join(dest, name));
}

console.log(`sync-core: ${names.length} file(s) -> ${path.relative(root, dest)}`);
