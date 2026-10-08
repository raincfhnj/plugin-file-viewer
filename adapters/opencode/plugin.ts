/**
 * OpenCode v1 server plugin (opencode 1.18.x / @opencode-ai/plugin 1.18.x).
 *
 * Loader rules this file obeys (verified against `opencode debug info`):
 * - default export is the async plugin function (`Plugin`) — the `{ id, server }`
 *   object form would also work, but the function form is what 1.18.35 loads;
 * - because default is a function, EVERY runtime export of this module must be a
 *   function or a `{ server }` object, otherwise the loader fails with
 *   "Plugin export is not a function". So: default only, plus type-only exports
 *   (erased by the loader's TS transform). Helpers live in ./host.ts / ./tools.ts
 *   and are imported, never re-exported.
 *
 * No hot reload: restart the opencode process after editing this file.
 */
import { tool, type Plugin } from '@opencode-ai/plugin';
import { resolveRepo } from './host.ts';
import { contentSearch, fileDiff, fileSearch, fileTree } from './tools.ts';

export default (async ({ directory }) => ({
  tool: {
    file_tree: tool({
      description:
        'List repository files as an indented tree with git status marks ' +
        '(M modified, A added, D deleted, ? untracked; a directory ending in ~ contains changes). ' +
        'Read-only; prefer this over ls/find for browsing. ' +
        'path: start directory (repo-relative or absolute, default repo root). ' +
        'depth: levels below path to show (1-10, default 3; ignored with changed_only). ' +
        'changed_only: only paths with git changes (needs a git repository).',
      args: {
        path: tool.schema.string().optional().describe('Start directory; default repository root'),
        depth: tool.schema
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe('Levels to show below path (default 3)'),
        changed_only: tool.schema
          .boolean()
          .optional()
          .describe('Only show paths with git changes (requires a git repository)'),
      },
      async execute(args, ctx) {
        const repo = await resolveRepo(ctx.directory || directory);
        return fileTree(repo, { path: args.path, depth: args.depth, changedOnly: args.changed_only });
      },
    }),

    file_diff: tool({
      description:
        'Unified diff of one file against a baseline, plus a view_policy hint (view= mode, ' +
        'modes= applicable cycle). path is repo-relative. baseline: HEAD (default) or Base ' +
        '(merge-base with the default base branch). full: full file context instead of 3-line hunks. ' +
        'Read-only; returns "no changes" when the file matches the baseline.',
      args: {
        path: tool.schema.string().describe('Repo-relative file path to diff'),
        baseline: tool.schema
          .enum(['HEAD', 'Base'])
          .optional()
          .describe('HEAD (default) or Base (merge-base with the default base branch)'),
        full: tool.schema
          .boolean()
          .optional()
          .describe('Full file context instead of the default 3-line hunks'),
      },
      async execute(args, ctx) {
        const repo = await resolveRepo(ctx.directory || directory);
        return fileDiff(repo, { path: args.path, baseline: args.baseline, full: args.full });
      },
    }),

    file_search: tool({
      description:
        'Fuzzy go-to-file over the repository (case-insensitive subsequence). Ranks basename ' +
        'hits above directory-only hits, shorter paths first. Returns lines "score  path", ' +
        'best match first. Read-only; use to locate files by partial name.',
      args: {
        query: tool.schema.string().describe('Fuzzy file-name query, e.g. "viewpol"'),
      },
      async execute(args, ctx) {
        const repo = await resolveRepo(ctx.directory || directory);
        return fileSearch(repo, { query: args.query });
      },
    }),

    content_search: tool({
      description:
        'Literal case-insensitive text search across repository text files (skips hidden ' +
        'directories, node_modules, binary and oversized files). Returns lines ' +
        '"path:line: matching text". limit caps the number of matches (default 100). ' +
        'Read-only; prefer this over grep for a bounded, repo-wide scan.',
      args: {
        query: tool.schema.string().describe('Literal text to search for'),
        limit: tool.schema
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe('Maximum matches to return (default 100)'),
      },
      async execute(args, ctx) {
        const repo = await resolveRepo(ctx.directory || directory);
        return contentSearch(repo, { query: args.query, limit: args.limit });
      },
    }),
  },
})) satisfies Plugin;
