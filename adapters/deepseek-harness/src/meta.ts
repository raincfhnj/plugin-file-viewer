/**
 * Sidebar metadata lines carried inside tool canonical output values.
 *
 * Chain (dsh 0.2.0-rc.2, verified against the shipped packages):
 * - `execute()` appends `sidebar address:` / `sidebar line:` lines for the
 *   file the caller should see in the right sidebar;
 * - `output.render()` strips them, so the model-facing content is unchanged;
 * - `output.presentationMeta()` re-projects them into `tool/result.meta`
 *   ("persisted verbatim on tool/result for Host presenters and Client
 *   renderers", @deepseek-ai/dsh-tools `ToolOutputDefinition` / `ToolResult`);
 * - the browser half (src/client.ts) reads `meta.fileViewer` on the durable
 *   `tool/result` event and calls `ctx.sidebarRight.openResource(...)`.
 *
 * The line grammar is shared with the `/files` command text the browser half
 * already parses: `sidebar address: <dsh-resource://…>` and `sidebar line: <n>`.
 * `sidebar tab: files` names a page open (`openTab('files')`) instead of a file.
 * file_tree emits no lines — `fileViewerMetaOf` derives its tab from the
 * `# file tree` title, keeping its canonical value byte-identical.
 */
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import { fileAddressFor, isAbsolutePath, toPosixPath } from './address.ts';

/** What the browser half should open for one tool result. */
export interface FileViewerMeta {
  /** `dsh-resource://file/session/…` address for the builtin text tab. */
  address?: string;
  /** 1-based line to focus (`openResource` `params.line`). */
  line?: number;
  /** Page open by kind (`openTab`). */
  tab?: string;
}

/** One `sidebar <key>: <value>` line. */
const META_LINE = /^sidebar (address|line|tab): (\S+)$/;

/** First line of `file_tree` output (tools.buildFileTreeText title). */
export const TREE_TITLE_MARK = '# file tree';

/** Append metadata lines to a canonical value (host side, `execute()`). */
export function appendSidebarMeta(text: string, meta: FileViewerMeta): string {
  const lines: string[] = [];
  if (meta.address) lines.push(`sidebar address: ${meta.address}`);
  if (meta.line !== undefined && Number.isInteger(meta.line) && meta.line >= 1) {
    lines.push(`sidebar line: ${meta.line}`);
  }
  if (meta.tab) lines.push(`sidebar tab: ${meta.tab}`);
  if (lines.length === 0) return text;
  return `${text.replace(/\n+$/, '')}\n${lines.join('\n')}`;
}

/** Remove metadata lines before the value reaches model-facing content. */
export function stripSidebarMeta(text: string): string {
  if (!text.includes('sidebar ')) return text;
  return text
    .split('\n')
    .filter((line) => !META_LINE.test(line))
    .join('\n');
}

/** Read metadata lines back out of a canonical value. */
export function parseSidebarMeta(text: string): FileViewerMeta {
  const meta: FileViewerMeta = {};
  for (const line of text.split('\n')) {
    const match = META_LINE.exec(line);
    if (!match) continue;
    const [, key, value] = match as unknown as [string, string, string];
    if (key === 'address') meta.address = value;
    else if (key === 'tab') meta.tab = value;
    else if (key === 'line') {
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed >= 1) meta.line = parsed;
    }
  }
  return meta;
}

/**
 * Project a canonical value into `output.presentationMeta`'s JSON result:
 * `{}` (no pane) or `{ fileViewer: { address?, line?, tab? } }`.
 *
 * file_tree carries no lines — its `# file tree` title maps to the `files`
 * page tab, so the shipped tree tool opens the workspace tree pane.
 */
export function fileViewerMetaOf(text: string): JsonValue {
  const meta = parseSidebarMeta(text);
  // Built key-by-key so the literal satisfies `JsonValue`'s index signature.
  const inner: { [key: string]: JsonValue } = {};
  if (meta.address) inner.address = meta.address;
  if (meta.line !== undefined) inner.line = meta.line;
  if (meta.tab) inner.tab = meta.tab;
  if (Object.keys(inner).length > 0) return { fileViewer: inner };
  if (text.startsWith(TREE_TITLE_MARK)) return { fileViewer: { tab: 'files' } };
  return {};
}

/**
 * Session-scope address for a workspace-root-relative (or absolute) tool path,
 * rooted like `/files`: absolute input is relativized against the session cwd,
 * relative input is joined onto `base` first (the git root when the path
 * namespace is git-root-relative) and then relativized the same way.
 *
 * Returns undefined — nothing to open — when the session id is unknown, the
 * target lies outside the session cwd, or the path is reported missing. An
 * `absolute`-scope fallback is never returned: the shipped `file` provider
 * rejects bare absolute addresses (`workspace-file/unknown-workspace`).
 */
export function sessionFileAddress(
  sessionId: string | undefined,
  cwd: string,
  base: string,
  path: string,
  text?: string,
): string | undefined {
  if (!sessionId) return undefined;
  if (text && text.includes('(path not found')) return undefined;
  const norm = toPosixPath(path);
  if (!norm) return undefined;
  let abs: string;
  if (isAbsolutePath(norm)) {
    abs = norm;
  } else {
    const root = toPosixPath(base);
    abs = root ? `${root}/${norm.replace(/^\/+/, '')}` : norm;
  }
  const address = fileAddressFor(sessionId, cwd, abs);
  return address.startsWith('dsh-resource://file/session/') ? address : undefined;
}
