import type { DirEntry, Host, RunResult } from './core/types.ts';
import { SAFE_GIT_ENV, SAFE_GIT_FLAGS } from './core/git.ts';

/** One `$.fs.list` entry, in the shape the mods API answers with. */
export interface FsEntryLike {
  name: string;
  kind: 'file' | 'dir' | 'other';
  size: number;
  isLink: boolean;
}

/**
 * The mods API, reached through closures `register.ts` builds over `$`.
 * Hooks and timers hand this object around; only `register.ts` may touch `$`,
 * which is why nothing here takes `$` as an argument.
 */
export interface Engine {
  cwd(): string;
  isWindows: boolean;
  list(path: string): Promise<FsEntryLike[]>;
  read(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  run(argv: string[], init?: { cwd?: string; env?: Record<string, string> }): Promise<RunResult>;
  after(ms: number, fn: () => void): { cancel(): void };
  storeGet(key: string): Promise<unknown>;
  storeSet(key: string, value: unknown): Promise<void>;
  invalidate(): void;
}

/** True for `C:/x`, `C:\x` or a UNC path — drives `SAFE_GIT_FLAGS`. */
export function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * The core `Host` over an `Engine`. Core paths are repo-root-relative and
 * POSIX; this is where they become absolute paths for `$.fs`, and where every
 * git call picks up `SAFE_GIT_FLAGS` / `SAFE_GIT_ENV`.
 *
 * `root` is the repo root (or the session cwd outside a repository).
 */
export function createHost(engine: Engine, root: string): Host {
  const base = root.replace(/\/+$/, '');
  const abs = (relPath: string): string => {
    const rel = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
    return rel === '' || rel === '.' ? base : `${base}/${rel}`;
  };

  return {
    cwd: () => engine.cwd(),
    isWindows: engine.isWindows,

    async listDir(relPath: string): Promise<DirEntry[]> {
      try {
        const entries = await engine.list(abs(relPath));
        return entries.map((entry) => ({
          name: entry.name,
          kind: entry.kind === 'dir' ? ('dir' as const) : ('file' as const),
          size: entry.size,
        }));
      } catch {
        return [];
      }
    },

    async readText(relPath: string): Promise<string> {
      return engine.read(abs(relPath));
    },

    async exists(relPath: string): Promise<boolean> {
      try {
        return await engine.exists(abs(relPath));
      } catch {
        return false;
      }
    },

    async runGit(dir: string, args: string[]): Promise<RunResult> {
      try {
        return await engine.run(['git', ...SAFE_GIT_FLAGS(engine.isWindows), ...args], {
          cwd: dir,
          env: SAFE_GIT_ENV,
        });
      } catch (err) {
        return { exitCode: -1, stdout: '', stderr: errorText(err) };
      }
    },
  };
}
