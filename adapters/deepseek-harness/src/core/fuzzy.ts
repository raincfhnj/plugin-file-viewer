/**
 * Fuzzy matching — case-insensitive subsequence scoring for the go-to-file finder.
 * Port of herdr-file-viewer src/fuzzy.rs (★B). Preserves that file's ranking contract:
 * - a query that lands inside the basename (after the last `/`) always outranks a
 *   directory-only hit (fuzzy.rs scores the directory-only case 1_000_000 worse);
 * - shorter paths win ties (fuzzy.rs: `length_score`);
 * - ASCII-only case folding (fuzzy.rs: `to_ascii_lowercase`);
 * - a query that is not a subsequence does not match (`None` → `undefined`).
 * Within a tier the score adds match-quality bonuses — prefix, path-separator/word
 * boundary, consecutive hits, exact match — which the Rust original does not rank by.
 */

/** Directory-only hits always sort below basename hits (fuzzy.rs `1_000_000` gap). */
const BASENAME_BONUS = 1_000_000;
/** One unit of match quality strictly outweighs any path-length tie-break. */
const QUALITY_SCALE = 10_000;
/** Keeps `units * QUALITY_SCALE` below BASENAME_BONUS so the basename tier always dominates. */
const MAX_QUALITY_UNITS = 99;
const UNIT_PER_CHAR = 4;
const BONUS_BOUNDARY = 8;
const BONUS_PREFIX = 5;
const BONUS_CONSECUTIVE = 6;
const BONUS_EXACT = 500;

const SEPARATORS = new Set(['/', '\\', '-', '_', '.', ' ', '\t', '(', '[', '{', ',', ':']);

/** ASCII-only lowercase fold: `A`-`Z` only, so non-ASCII compares exactly (fuzzy.rs). */
function foldAscii(ch: string): string {
  const c = ch.charCodeAt(0);
  return c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : ch;
}

function foldAsciiAll(s: string): string[] {
  return Array.from(s, foldAscii);
}

function isSubsequence(pattern: readonly string[], text: readonly string[]): boolean {
  let i = 0;
  for (const ch of text) {
    if (i < pattern.length && pattern[i] === ch) i++;
    if (i === pattern.length) return true;
  }
  return pattern.length === 0;
}

/** Word boundary at `idx`: start of target, after a path/word separator, or camelCase. */
function isBoundary(orig: readonly string[], idx: number): boolean {
  if (idx === 0) return true;
  const prev = orig[idx - 1];
  if (SEPARATORS.has(prev)) return true;
  const p = prev.charCodeAt(0);
  const c = orig[idx].charCodeAt(0);
  const prevWord = (p >= 97 && p <= 122) || (p >= 48 && p <= 57);
  return prevWord && c >= 65 && c <= 90;
}

/**
 * Score pattern against target; `undefined` = no match. Higher is better.
 * Case-insensitive (ASCII fold); a full match of the basename earns the basename tier.
 */
export function fuzzyScore(pattern: string, target: string): number | undefined {
  if (pattern.length === 0) return 0;
  const p = foldAsciiAll(pattern);
  const orig = Array.from(target);
  const t = orig.map(foldAscii);
  let units = 0;
  let ti = 0;
  let prevIdx = -2;
  for (let pi = 0; pi < p.length; pi++) {
    let idx = ti;
    while (idx < t.length && t[idx] !== p[pi]) idx++;
    if (idx >= t.length) return undefined;
    units += UNIT_PER_CHAR;
    if (isBoundary(orig, idx)) units += BONUS_BOUNDARY;
    if (pi === 0 && idx === 0) units += BONUS_PREFIX;
    if (idx === prevIdx + 1) units += BONUS_CONSECUTIVE;
    prevIdx = idx;
    ti = idx + 1;
  }
  if (p.length === t.length && p.every((ch, i) => ch === t[i])) units += BONUS_EXACT;
  const sep = target.lastIndexOf('/');
  const basenameHit = isSubsequence(p, foldAsciiAll(sep >= 0 ? target.slice(sep + 1) : target));
  units = Math.min(units, MAX_QUALITY_UNITS);
  const lengthPenalty = Math.min(target.length, QUALITY_SCALE - 1);
  return (basenameHit ? BASENAME_BONUS : 0) + units * QUALITY_SCALE - lengthPenalty;
}

/**
 * Filter+rank items by fuzzy score against `key(item)`; best first.
 * Non-matches are dropped, equal scores keep their original order, and an empty
 * pattern yields no results (fuzzy.rs `match_and_rank`: empty query → empty Vec, AC-2).
 */
export function fuzzyFilter<T>(
  pattern: string,
  items: readonly T[],
  key: (t: T) => string,
): Array<{ item: T; score: number }> {
  if (pattern.length === 0) return [];
  const scored: Array<{ item: T; score: number; index: number }> = [];
  for (let i = 0; i < items.length; i++) {
    const score = fuzzyScore(pattern, key(items[i]));
    if (score !== undefined) scored.push({ item: items[i], score, index: i });
  }
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map(({ item, score }) => ({ item, score }));
}
