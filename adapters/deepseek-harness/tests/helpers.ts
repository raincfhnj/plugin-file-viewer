/** Shared fake `Host` for adapter tests — in-memory tree, scripted git. */
import type { DirEntry, Host, RunResult } from '../src/core/types.ts';

export const OK = (stdout = ''): RunResult => ({ exitCode: 0, stdout, stderr: '' });
export const FAIL = (exitCode: number, stderr = 'boom'): RunResult => ({
  exitCode,
  stdout: '',
  stderr,
});

export interface FakeHostOptions {
  /** Session cwd (POSIX absolute). Defaults to `/ws`. */
  cwd?: string;
  /** Answer for every `runGit` (receives argv WITHOUT safety flags). */
  git?: (args: string[], dir: string) => RunResult;
}

/**
 * Build a fake Host over `files` (`path → content`, POSIX, cwd-relative).
 * Directories are inferred from file paths; empty dirs can be listed in `dirs`.
 */
export function fakeHost(
  files: Record<string, string>,
  opts: FakeHostOptions & { dirs?: string[] } = {},
): Host {
  const cwd = opts.cwd ?? '/ws';
  const dirs = new Set(opts.dirs ?? []);
  for (const p of Object.keys(files)) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }

  const children = (dir: string): DirEntry[] => {
    const prefix = dir === '' ? '' : `${dir}/`;
    const out: DirEntry[] = [];
    const seen = new Set<string>();
    for (const p of Object.keys(files)) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (!rest.includes('/')) {
        if (seen.has(rest)) continue;
        seen.add(rest);
        out.push({ name: rest, kind: 'file', size: files[p].length });
      } else {
        const name = rest.split('/')[0]!;
        if (seen.has(name)) continue;
        seen.add(name);
        out.push({ name, kind: 'dir' });
      }
    }
    for (const d of dirs) {
      if (d === dir || !d.startsWith(prefix)) continue;
      const rest = d.slice(prefix.length);
      if (rest.includes('/')) continue;
      if (seen.has(rest)) continue;
      seen.add(rest);
      out.push({ name: rest, kind: 'dir' });
    }
    return out;
  };

  return {
    isWindows: false,
    cwd: () => cwd,
    async listDir(relPath: string): Promise<DirEntry[]> {
      const dir = relPath.replace(/^\.\//, '').replace(/\/+$/, '');
      if (dir !== '' && !dirs.has(dir) && !Object.keys(files).some((p) => p.startsWith(`${dir}/`))) {
        return [];
      }
      return children(dir);
    },
    async readText(relPath: string): Promise<string> {
      const content = files[relPath.replace(/^\.\//, '')];
      if (content === undefined) throw new Error(`ENOENT: ${relPath}`);
      return content;
    },
    async exists(relPath: string): Promise<boolean> {
      const p = relPath.replace(/^\.\//, '');
      if (files[p] !== undefined || dirs.has(p)) return true;
      return Object.keys(files).some((f) => f.startsWith(`${p}/`));
    },
    async runGit(dir: string, args: string[]): Promise<RunResult> {
      if (!opts.git) return FAIL(128, 'fatal: not a git repository');
      return opts.git(args, dir);
    },
  };
}

/** `git status --porcelain=v1 -z` payload from `XY path` records. */
export function porcelain(...records: string[]): string {
  return records.join(String.fromCharCode(0)) + String.fromCharCode(0);
}
