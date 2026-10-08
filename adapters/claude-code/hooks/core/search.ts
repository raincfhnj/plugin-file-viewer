/**
 * Content search — bounded line scan producing `path:line` rows.
 * Port of herdr-file-viewer src/search.rs + src/repo_search.rs (★B): literal
 * case-insensitive matching, non-text/binary/oversized skips, bounded excerpts,
 * and a deterministic file-name-ordered walk. v0.1 simplification (ARCHITECTURE §2):
 * no .gitignore rules — hidden entries and node_modules are skipped instead.
 */
import type { DirEntry, Host } from './types.ts';

/** One matching source line (repo_search.rs SearchHit without the column field). */
export interface SearchMatch {
  /** Repo-root-relative POSIX path. */
  path: string;
  /** One-based source line. */
  line: number;
  /** The matching line, trimmed; long lines are windowed around the match with '…'. */
  text: string;
}

export interface SearchOptions {
  /** Max matches to return (default 200). */
  limit?: number;
  /** Skip files larger than this many bytes (default 1 MiB, repo_search.rs MAX_FILE_BYTES). */
  maxFileBytes?: number;
}

const DEFAULT_LIMIT = 200;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
/** Excerpt body width in code points, excluding edge ellipses (MAX_EXCERPT_CHARS). */
const MAX_EXCERPT_CHARS = 160;

const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|markdown|rs|py|go|java|kt|c|h|cc|cpp|hpp|cs|rb|php|sh|bash|zsh|toml|yaml|yml|ini|cfg|conf|txt|css|scss|html|xml|sql|lua|swift|scala|vue|svelte)$/i;

const SKIP_DIRS = new Set(['node_modules']);

/** True when a path is plausibly searchable text (case-insensitive extension allow-list). */
export function isSearchable(path: string): boolean {
  return TEXT_EXT.test(path);
}

/** ASCII-only lowercase fold — length-preserving, so offsets into the folded copy stay
 * valid for the original text (search.rs `to_ascii_lowercase`). */
function foldAscii(text: string): string {
  return text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** Bounded excerpt around [matchStart, matchEnd) (code-unit offsets into `line`): short
 * lines return the trimmed line; long lines keep the match whole inside a 160-code-point
 * window with '…' edges (repo_search.rs `excerpt_around`). */
function excerptAround(line: string, matchStart: number, matchEnd: number): string {
  const chars = Array.from(line);
  const total = chars.length;
  if (total <= MAX_EXCERPT_CHARS) return line.trim();
  const startChar = Array.from(line.slice(0, matchStart)).length;
  const matchLen = Array.from(line.slice(matchStart, matchEnd)).length;
  const beforeBudget = Math.floor(Math.max(0, MAX_EXCERPT_CHARS - matchLen) / 2);
  let start = Math.max(0, startChar - beforeBudget);
  let end = Math.min(start + MAX_EXCERPT_CHARS, total);
  if (end === total) start = Math.max(0, total - MAX_EXCERPT_CHARS);
  if (startChar + matchLen > end) {
    end = Math.min(startChar + matchLen, total);
    start = Math.max(0, end - Math.max(MAX_EXCERPT_CHARS, matchLen));
  }
  const body = chars.slice(start, end).join('').trim();
  return (start > 0 ? '…' : '') + body + (end < total ? '…' : '');
}

/**
 * Search text files under `root` for `query` (ASCII case-insensitive, literal substring),
 * one row per matching line (first occurrence only), in deterministic file-name order.
 * Skips hidden entries, node_modules, non-text extensions, NUL-containing (binary) files,
 * files over `maxFileBytes`, and unreadable files. Stops once `limit` matches are reached.
 */
export async function searchContent(
  host: Host,
  root: string,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchMatch[]> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const matches: SearchMatch[] = [];
  if (query.length === 0 || limit <= 0) return matches;
  const needle = foldAscii(query);

  const walk = async (dir: string): Promise<void> => {
    if (matches.length >= limit) return;
    let entries: DirEntry[];
    try {
      entries = await host.listDir(dir);
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (matches.length >= limit) return;
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const path = dir === '' ? e.name : `${dir}/${e.name}`;
      if (e.kind === 'dir') {
        await walk(path);
        continue;
      }
      if (!isSearchable(path)) continue;
      if (e.size !== undefined && e.size > maxBytes) continue;
      let text: string;
      try {
        text = await host.readText(path);
      } catch {
        continue;
      }
      if (text.length > maxBytes) continue;
      if (text.includes(String.fromCharCode(0))) continue; // binary (NUL byte) sniff
      const haystack = foldAscii(text);
      if (!haystack.includes(needle)) continue;
      const lines = text.split('\n');
      const folded = haystack.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (matches.length >= limit) return;
        const at = folded[i].indexOf(needle);
        if (at < 0) continue;
        matches.push({ path, line: i + 1, text: excerptAround(lines[i], at, at + needle.length) });
      }
    }
  };

  await walk(root);
  return matches;
}
