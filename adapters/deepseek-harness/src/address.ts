/**
 * `dsh-resource://file/...` address grammar for the right sidebar's builtin
 * `text` tab — a host-side mirror of `fileAddressFor` from
 * `@deepseek-ai/util/workspace-path`.
 *
 * Grammar (docs/subsystems/sidebar-right.md):
 * - session scope: `dsh-resource://file/session/<sessionId>/<path-relative-to-workspace>`
 * - absolute scope: `dsh-resource://file/absolute/<absolute-path-with-leading-slash-dropped>`
 *   (Windows: `dsh-resource://file/absolute/C:/x/y.txt`)
 * - every id and path segment is component-encoded, with `:` kept literal
 *   (drive letters survive).
 *
 * Note: bare `absolute` addresses carry no authorizing Session and the shipped
 * `file` provider rejects them (`workspace-file/unknown-workspace`); a session
 * address is the one that renders in the Web Client.
 */

/** Encode one path/id segment; `:` stays literal per the grammar. */
export function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%3A/gi, ':');
}

/** POSIX-normalize (backslashes → slashes) and strip a trailing slash. */
export function toPosixPath(input: string): string {
  return input.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** True for `D:/…` or `/…` after POSIX normalization. */
export function isAbsolutePath(input: string): boolean {
  const norm = toPosixPath(input);
  return norm.startsWith('/') || /^[A-Za-z]:\//.test(norm);
}

/**
 * Workspace-relative POSIX path for `path`, or `undefined` when it lies outside
 * `cwd` (or `cwd` is unknown). Comparison is case-insensitive on Windows-shaped
 * drive paths, case-sensitive elsewhere.
 */
export function relativeToWorkspace(cwd: string, path: string): string | undefined {
  const base = toPosixPath(cwd);
  if (!base) return undefined;
  const norm = toPosixPath(path);
  const folded = /^[A-Za-z]:\//.test(base);
  const cmp = (value: string): string => (folded ? value.toLowerCase() : value);
  if (cmp(norm) === cmp(base)) return '';
  const prefix = base.endsWith('/') ? base : base + '/';
  if (cmp(norm).startsWith(cmp(prefix))) return norm.slice(prefix.length);
  return undefined;
}

/**
 * Build the file resource address for a path.
 *
 * - relative input (or an absolute path inside `cwd`) + known `sessionId`
 *   → session scope (the address the Web Client can actually open);
 * - anything else falls back to absolute scope.
 */
export function fileAddressFor(
  sessionId: string | undefined,
  cwd: string,
  path: string,
): string {
  const norm = toPosixPath(path);
  const rel = isAbsolutePath(norm) ? relativeToWorkspace(cwd, norm) : norm.replace(/^\.\//, '');

  if (sessionId && rel !== undefined && !rel.startsWith('..')) {
    const scope = `session/${encodeSegment(sessionId)}`;
    const relSegments = rel.split('/').filter((s) => s.length > 0);
    return relSegments.length > 0
      ? `dsh-resource://file/${scope}/${relSegments.map(encodeSegment).join('/')}`
      : `dsh-resource://file/${scope}`;
  }

  // Absolute scope: resolve relative input against cwd, drop the leading `/`.
  const abs = isAbsolutePath(norm) ? norm : `${toPosixPath(cwd)}/${norm}`;
  const withoutLeadingSlash = abs.replace(/^\/+/, '');
  return `dsh-resource://file/absolute/${withoutLeadingSlash
    .split('/')
    .map(encodeSegment)
    .join('/')}`;
}
