/**
 * Build the browser half: `src/client.ts` → `client.js` in the client-modules
 * bundle format (`window.__ModuleLoader__.load({ id, factory })`, CommonJS
 * factory body — the exact wrapper the shipped client packages use).
 *
 * The body is a fully self-contained esbuild CJS bundle (no bare imports), so
 * the factory never calls `require` and no graph edge beyond the package's
 * `dsh.client.inject` manifest list is needed at runtime.
 *
 * Run: node scripts/build-client.mjs   (or npm run build:client)
 */
import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

const result = await build({
  entryPoints: [join(root, 'src', 'client.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2021',
  write: false,
  legalComments: 'none',
  logLevel: 'warning',
});

const banner =
  'window.__ModuleLoader__.load({\n' +
  `\tid: ${JSON.stringify(pkg.name)},\n` +
  '\tfactory: (require) => {\n' +
  '\t\tvar module = { exports: {} };\n' +
  '\t\tvar exports = module.exports;\n' +
  '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });\n';
const footer = '\n\t\treturn module.exports;\n\t}\n});\n';

const code = result.outputFiles[0].text;
if (code.includes('require(')) {
  throw new Error('build-client: bundle still calls require() — add the dependency to dsh.client.inject');
}
await writeFile(join(root, 'client.js'), banner + code + footer, 'utf8');
console.log(`[file-viewer] built client.js (${Buffer.byteLength(banner + code + footer)} bytes)`);
