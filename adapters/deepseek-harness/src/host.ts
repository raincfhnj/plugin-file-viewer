/**
 * Node implementation of the core `Host` contract for the dsh adapter.
 *
 * The dsh plugin runs in-process on the Host (no sandbox), so plain
 * `node:fs/promises` + `child_process.execFile` are the I/O surface. Every git
 * invocation carries `SAFE_GIT_FLAGS` / `SAFE_GIT_ENV` from core/git.ts and
 * never goes through a shell.
 */
import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { DirEntry, Host, NodeKind, RunResult } from './core/types.ts';
import { MAX_DIFF_BYTES, SAFE_GIT_ENV, SAFE_GIT_FLAGS } from './core/git.ts';

/** Contract cap: adapters reject UTF-8 text files above 4 MiB. */
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
/** Host.runGit timeout (30s, per the Host contract). */
const GIT_TIMEOUT_MS = 30_000;
/** execFile buffer: diff capture is capped at MAX_DIFF_BYTES by contract. */
const GIT_MAX_BUFFER = MAX_DIFF_BYTES;

/** Forward-slash form of an absolute path (Windows `D:\x` → `D:/x`). */
export function toPosix(abs: string): string {
  return abs.replace(/\\/g, '/');
}

export interface NodeHostOptions {
  /** Fallback working directory; defaults to `process.cwd()` read per call. */
  cwd?: () => string;
}

/**
 * Build a `Host` bound to `baseCwd()`. Relative paths resolve against it;
 * absolute paths pass through (so `repoRoot` POSIX results stay usable on
 * Windows, where `path.resolve` accepts `/` separators).
 */
export function createNodeHost(options: NodeHostOptions = {}): Host {
  const baseCwd = options.cwd ?? ((): string => process.cwd());
  const isWindows = process.platform === 'win32';

  const resolvePath = (relPath: string): string => {
    const normalized = relPath.replace(/\\/g, '/');
    if (path.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) {
      return path.normalize(normalized);
    }
    return path.resolve(baseCwd(), normalized);
  };

  return {
    isWindows,

    cwd(): string {
      return toPosix(baseCwd());
    },

    async listDir(relPath: string): Promise<DirEntry[]> {
      let entries;
      try {
        entries = await readdir(resolvePath(relPath), { withFileTypes: true });
      } catch {
        return []; // missing dir / permission error → empty (Host contract)
      }
      return Promise.all(
        entries.map(async (entry) => {
          const kind: NodeKind = entry.isDirectory() ? 'dir' : 'file';
          let size: number | undefined;
          if (kind === 'file') {
            try {
              size = (await stat(path.join(resolvePath(relPath), entry.name))).size;
            } catch {
              size = undefined;
            }
          }
          return size === undefined ? { name: entry.name, kind } : { name: entry.name, kind, size };
        }),
      );
    },

    async readText(relPath: string): Promise<string> {
      const abs = resolvePath(relPath);
      const info = await stat(abs);
      if (info.size > MAX_TEXT_BYTES) {
        throw new Error(`readText: ${relPath} exceeds the 4 MiB cap (${info.size} bytes)`);
      }
      const text = await readFile(abs, 'utf8');
      if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
        throw new Error(`readText: ${relPath} exceeds the 4 MiB cap after decoding`);
      }
      return text;
    },

    async exists(relPath: string): Promise<boolean> {
      try {
        await stat(resolvePath(relPath));
        return true;
      } catch {
        return false;
      }
    },

    async runGit(dir: string, args: string[]): Promise<RunResult> {
      const argv = [...SAFE_GIT_FLAGS(isWindows), ...args];
      return await new Promise<RunResult>((resolve) => {
        execFile(
          'git',
          argv,
          {
            cwd: resolvePath(dir),
            env: { ...process.env, ...SAFE_GIT_ENV },
            encoding: 'utf8',
            windowsHide: true,
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: GIT_MAX_BUFFER,
          },
          (error, stdout, stderr) => {
            if (!error) {
              resolve({ exitCode: 0, stdout, stderr });
              return;
            }
            // Non-zero git exit carries a numeric `code` (e.g. 1 for
            // `git diff --no-index`, 128 outside a repo); spawn/timeout
            // failures carry a string code or none — degrade those to -1.
            const code = typeof error.code === 'number' ? error.code : -1;
            resolve({
              exitCode: code,
              stdout: stdout ?? '',
              stderr: stderr ?? String(error.message ?? ''),
            });
          },
        );
      });
    },
  };
}
