/**
 * git service — read-only answers (port of herdr-file-viewer src/git.rs).
 *
 * Hardening contract (from the Rust original):
 * - Only read-only git subcommands; no shell; argv arrays only.
 * - Neutralize repo-controlled code execution: --no-ext-diff, --no-textconv (diff
 *   subcommand level — see SAFE_DIFF_FLAGS), -c core.fsmonitor=,
 *   -c core.hooksPath=/dev/null (NUL on Windows) as global flags.
 * - GIT_OPTIONAL_LOCKS=0 so status/diff never write the index.
 * Adapters implement this via Host.runGit; this module only composes args and
 * parses output. See SAFE_GIT_FLAGS / SAFE_DIFF_FLAGS / SAFE_GIT_ENV.
 */
import type { Baseline, GitStatus, Host, RunResult } from './types.ts';

/**
 * Flags every git call must carry (adapters prepend these to argv). Only options
 * git accepts BEFORE the subcommand live here: global flags and `-c` overrides.
 * (`--no-ext-diff` / `--no-textconv` are `git diff` options — git rejects them as
 * global options with exit 129 — so they are NOT part of this list.)
 */
export const SAFE_GIT_FLAGS = (isWindows: boolean): string[] => [
  '-c', 'core.fsmonitor=',
  '-c', 'core.hooksPath=' + (isWindows ? 'NUL' : '/dev/null'),
];

/**
 * Diff-level safety flags (repo-controlled ext-diff/textconv drivers off). They are
 * `git diff` OPTIONS, so they must be inserted AFTER the `diff` subcommand — which
 * is where this module puts them when composing diff argv.
 */
export const SAFE_DIFF_FLAGS: string[] = ['--no-ext-diff', '--no-textconv'];

/** The env every git call must carry. */
export const SAFE_GIT_ENV: Record<string, string> = { GIT_OPTIONAL_LOCKS: '0' };

/** git's empty-tree object — baseline for an unborn repo. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Full-context diff: -U larger than any real file. */
export const FULL_CONTEXT = '-U1000000';

/** Hard cap on diff bytes the host should capture (4 MB). */
export const MAX_DIFF_BYTES = 4 * 1024 * 1024;

/** The NUL byte git uses as its -z field delimiter. */
const NUL = String.fromCharCode(0);

/**
 * Parse `git status --porcelain=v1 -z -uall` output into a per-path status map.
 * Key: repo-root-relative path, POSIX separators (backslashes normalized).
 * Pure: string in, map out. Defensive: truncated records and blank codes are
 * skipped; a rename/copy consumes the extra NUL field holding the ORIGINAL path
 * (in `-z` the record's own path is the NEW one) and keys that new path.
 */
export function parsePorcelainStatus(out: string): Map<string, GitStatus> {
  const map = new Map<string, GitStatus>();
  const fields = out.split(NUL).filter((f) => f.length > 0);
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i];
    if (rec.length < 3) continue;
    const code = rec.slice(0, 2);
    const rawPath = rec.slice(3);
    // Rename/copy: next NUL field is the original path — consume it so it is not
    // parsed as a record of its own; the record's own (new) path is still keyed.
    if (code.includes('R') || code.includes('C')) i++;
    const status = classify(code);
    if (!status) continue;
    const path = rawPath.replace(/\\/g, '/');
    if (!map.has(path)) map.set(path, status);
  }
  return map;
}

/**
 * Two-letter XY code → GitStatus, or undefined when the code is blank
 * (unmodified/ignored). Unknown-but-non-empty codes (unmerged `UU`, copy `C `,
 * anything git may grow) fall through to Modified, matching git.rs.
 */
export function classify(code: string): GitStatus | undefined {
  if (code === '??') return 'Untracked';
  if (code.includes('D')) return 'Deleted';
  if (code.includes('A')) return 'Added';
  if (code.trim() === '') return undefined;
  return 'Modified';
}

/** Per-file working-tree status for tree markers. Not a repo / git missing → empty. */
export async function status(host: Host, repoRootPath: string): Promise<Map<string, GitStatus>> {
  const r = await host.runGit(repoRootPath, ['status', '--porcelain=v1', '-z', '-uall']);
  if (r.exitCode !== 0) return new Map();
  return parsePorcelainStatus(r.stdout);
}

/** True when dir is inside a git work tree. */
export async function isRepo(host: Host, dir: string): Promise<boolean> {
  const r = await host.runGit(dir, ['rev-parse', '--is-inside-work-tree']);
  return r.exitCode === 0 && r.stdout.trim() === 'true';
}

/** Repo root (absolute, POSIX-normalized) for dir, or undefined when not a repo. */
export async function repoRoot(host: Host, dir: string): Promise<string | undefined> {
  const r = await host.runGit(dir, ['rev-parse', '--show-toplevel']);
  if (r.exitCode !== 0) return undefined;
  const root = r.stdout.trim();
  return root.length > 0 ? root.replace(/\\/g, '/') : undefined;
}

/**
 * Unified diff text for one repo-root-relative path against the baseline.
 * - Untracked: `git diff --no-index` against the null device (whole file as added).
 * - baseline 'HEAD': `git diff HEAD -- path` (unborn HEAD → empty-tree retry).
 * - baseline 'Base': merge-base against opts.baseBranch (or the default base branch).
 * Not a repo / git failure → '' (degrade to neutral, AC-26).
 */
export async function fileDiff(
  host: Host,
  repoRootPath: string,
  relPath: string,
  baseline: Baseline,
  opts: { baseBranch?: string; fullContext?: boolean } = {},
): Promise<string> {
  const norm = relPath.replace(/\\/g, '/');

  if (baseline === 'HEAD') {
    const st = await status(host, repoRootPath);
    if (st.get(norm) === 'Untracked') return untrackedDiff(host, repoRootPath, norm);
    const args = ['diff', ...SAFE_DIFF_FLAGS];
    if (opts.fullContext) args.push(FULL_CONTEXT);
    args.push('HEAD', '--', norm);
    const r = await host.runGit(repoRootPath, args);
    if (r.exitCode === 0) return r.stdout;
    // Unborn HEAD: `git diff HEAD` fails with "bad revision 'HEAD'" — retry against
    // the empty tree so a fresh repo's first (staged) files still diff as additions
    // (git.rs head_or_empty_tree). A non-repo fails again and degrades to ''.
    const retry = [...args];
    retry[retry.indexOf('HEAD')] = EMPTY_TREE;
    const r2 = await host.runGit(repoRootPath, retry);
    return r2.exitCode === 0 ? r2.stdout : '';
  }

  const base = opts.baseBranch ?? (await defaultBaseBranch(host, repoRootPath));
  if (!base) {
    // No base branch: fall back to HEAD behaviour.
    return fileDiff(host, repoRootPath, norm, 'HEAD', opts);
  }
  const mb = await host.runGit(repoRootPath, ['merge-base', 'HEAD', base]);
  const from = mb.exitCode === 0 && mb.stdout.trim() ? mb.stdout.trim() : base;
  const st = await status(host, repoRootPath);
  if (st.get(norm) === 'Untracked') return untrackedDiff(host, repoRootPath, norm);
  const args = ['diff', ...SAFE_DIFF_FLAGS];
  if (opts.fullContext) args.push(FULL_CONTEXT);
  args.push(from, '--', norm);
  const r = await host.runGit(repoRootPath, args);
  return r.exitCode === 0 ? r.stdout : '';
}

/** Whole-file added diff for an untracked path. */
async function untrackedDiff(host: Host, repoRootPath: string, norm: string): Promise<string> {
  const nullDev = host.isWindows ? 'NUL' : '/dev/null';
  const r = await host.runGit(repoRootPath, [
    'diff',
    ...SAFE_DIFF_FLAGS,
    '--no-index',
    '--',
    nullDev,
    norm,
  ]);
  // git diff --no-index exits 1 when the files differ — still a valid diff.
  if (r.exitCode !== 0 && r.exitCode !== 1) return '';
  return normalizeNoIndex(r.stdout, norm);
}

/**
 * `git diff --no-index /dev/null path` headers reference the null device —
 * rewrite them so the diff reads as a plain add of `relPath`.
 */
export function normalizeNoIndex(stdout: string, relPath: string): string {
  return stdout
    .split('\n')
    .map((line) => {
      if (line.startsWith('diff --git')) return `diff --git a/${relPath} b/${relPath}`;
      if (line.startsWith('--- ')) return '--- /dev/null';
      if (line.startsWith('+++ ')) return `+++ b/${relPath}`;
      return line;
    })
    .join('\n');
}

/** Best-effort default base branch: origin/HEAD → origin/main → origin/master → main → master. */
export async function defaultBaseBranch(host: Host, repoRootPath: string): Promise<string | undefined> {
  const sym = await host.runGit(repoRootPath, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
  if (sym.exitCode === 0) {
    const m = /refs\/remotes\/(.+)$/.exec(sym.stdout.trim());
    if (m) return m[1];
  }
  for (const cand of ['origin/main', 'origin/master', 'main', 'master']) {
    const r = await host.runGit(repoRootPath, ['rev-parse', '--verify', cand]);
    if (r.exitCode === 0) return cand;
  }
  return undefined;
}

/** Apply SAFE flags/env around a raw runner — exported so adapters share one path. */
export async function safeRun(
  raw: (args: string[], env: Record<string, string>) => Promise<RunResult>,
  args: string[],
  isWindows = false,
): Promise<RunResult> {
  return raw([...SAFE_GIT_FLAGS(isWindows), ...args], SAFE_GIT_ENV);
}
