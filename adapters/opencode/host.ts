/// <reference types="node" />
/**
 * Node.js `Host` for the OpenCode adapter (core/types.ts Host over node:fs +
 * node:child_process). OpenCode plugins run in a Bun-flavoured runtime but the
 * node: builtins are available, and the plugin file's bare imports resolve from
 * its own location upward — so this adapter only relies on node: builtins plus
 * `@opencode-ai/plugin` installed at the repository root.
 *
 * Path contract: core speaks repo-root-relative POSIX paths; this module is the
 * only place they become absolute (and Windows backslashes get normalized).
 * git calls always carry SAFE_GIT_FLAGS / SAFE_GIT_ENV and never a shell.
 */
import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import type { DirEntry, Host, RunResult } from './core/types.ts';
import { SAFE_GIT_ENV, SAFE_GIT_FLAGS, repoRoot } from './core/git.ts';
import type { RepoContext } from './tools.ts';

/** Host.readText contract: files over 4 MiB must throw instead of loading. */
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
/** git invocations are read-only and small; 30s timeout, 8 MiB output cap. */
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

/** Absolute path → POSIX separators without a trailing slash (keep `C:/` intact). */
export function normalizePath(p: string): string {
  const norm = p.replace(/\\/g, '/');
  const stripped = norm.replace(/\/+$/, '');
  return stripped === '' || stripped.endsWith(':') ? norm : stripped;
}

/** Run one git argv (safety flags already applied by Host.runGit) in `cwd`. */
function execGit(cwd: string, argv: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      argv,
      {
        cwd,
        env: { ...process.env, ...SAFE_GIT_ENV },
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: GIT_MAX_BUFFER,
      },
      (err, stdout, stderr) => {
        if (err === null) {
          resolve({ exitCode: 0, stdout, stderr });
          return;
        }
        // Non-zero git exit surfaces as a numeric `code`; spawn failures
        // (ENOENT, timeout kill) carry a string/no code → degraded -1.
        const code = (err as { code?: unknown }).code;
        if (typeof code === 'number') {
          resolve({ exitCode: code, stdout, stderr });
          return;
        }
        resolve({ exitCode: -1, stdout: '', stderr: err.message });
      },
    );
  });
}

/**
 * Host rooted at `root` (relative core paths resolve against it), with `cwd()`
 * reporting the session directory. Outside a repository both are the session
 * directory; inside one `root` is the repo root from `git rev-parse`.
 */
export function createHost(root: string, cwd = root): Host {
  const base = normalizePath(root);
  const isWindows = process.platform === 'win32';
  const abs = (relPath: string): string => {
    const rel = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
    if (rel === '' || rel === '.') return base;
    if (rel.startsWith('/') || /^[A-Za-z]:\//.test(rel)) return rel;
    return `${base}/${rel}`;
  };

  return {
    cwd: () => normalizePath(cwd),
    isWindows,

    async listDir(relPath: string): Promise<DirEntry[]> {
      const dir = abs(relPath);
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return []; // missing dir / permission error → empty, per Host contract
      }
      const out: DirEntry[] = [];
      for (const entry of entries) {
        if (entry.isDirectory()) {
          out.push({ name: entry.name, kind: 'dir' });
          continue;
        }
        let size: number | undefined;
        try {
          size = (await stat(`${dir}/${entry.name}`)).size;
        } catch {
          size = undefined; // broken symlink etc. — size is optional
        }
        out.push({ name: entry.name, kind: 'file', size });
      }
      return out;
    },

    async readText(relPath: string): Promise<string> {
      const file = abs(relPath);
      const info = await stat(file); // throws when missing
      if (info.size > MAX_TEXT_BYTES) {
        throw new Error(`file too large: ${relPath} is ${info.size} bytes (cap ${MAX_TEXT_BYTES})`);
      }
      return readFile(file, 'utf8');
    },

    async exists(relPath: string): Promise<boolean> {
      try {
        await stat(abs(relPath));
        return true;
      } catch {
        return false;
      }
    },

    async runGit(dir: string, args: string[]): Promise<RunResult> {
      try {
        return await execGit(dir, [...SAFE_GIT_FLAGS(isWindows), ...args]);
      } catch (err) {
        return { exitCode: -1, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

/**
 * Session directory → repo context: a Host rooted at `git rev-parse
 * --show-toplevel` when the directory is inside a work tree, otherwise the
 * session directory itself with `git: false` (status/diff degrade to empty).
 */
export async function resolveRepo(directory: string): Promise<RepoContext> {
  const cwd = normalizePath(directory);
  const base = createHost(cwd, cwd);
  const root = await repoRoot(base, cwd);
  if (root !== undefined && root !== '') {
    return { host: createHost(root, cwd), root, git: true };
  }
  return { host: base, root: cwd, git: false };
}
