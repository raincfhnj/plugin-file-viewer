---
name: file-viewer
description: Open and drive the git-aware Files pane (the file-viewer mod). Use when the user asks to open, show, or inspect a file in the Files pane — e.g. "open src/x.ts:42 in Files", "show me the diff", "look at README.md", "what changed" — or asks which keys the viewer pane supports.
---

# Files pane — `/files`

The `file-viewer` mod adds a read-only, git-aware viewer pane to Claude Code.
It shows a repository tree on the left and, on the right, the view that file
deserves: a **diff** when it changed, **rendered markdown** for `.md`, or
**highlighted code** otherwise.

## Opening it

```
/files [path[:line]]
```

- Registered at `session.start` with `immediate: true`, so it runs even while
  Claude is working on a turn.
- The command returns no transcript text; the pane itself is the output.
- A path is resolved against the **session cwd** and then mapped onto the
  **repository root** (that is what the tree and `git status` are keyed on).
  Absolute paths are accepted when they sit inside the repository.
- A `:line` argument scrolls the content window to that line and forces the
  plain source view (`code`, or `markdown` for `.md`) so the line is visible
  rather than hidden inside a diff.

### Telling the user what to type

A slash command is run by the person at the prompt, not by Claude. When the
user asks you to "open `src/x.ts:42` in Files", reply with the exact command
and the path as the repo sees it:

> Run `/files src/x.ts:42`

Resolve the path first: if the user names a path relative to something that is
not the session cwd, convert it to a repo-root-relative POSIX path
(`src/x.ts`, `docs/README.md`) before showing the command. If the file does not
exist, say so instead of offering a command that will land on "not found" in
the status line.

## Keys inside the pane

The pane must hold the keyboard (it opens with focus; `Esc` closes it,
`Ctrl+X` `Tab` moves focus back to it).

| Key | Button | What it does |
| --- | --- | --- |
| `f` | `f: find` | Fuzzy-find a file: type a fragment, `Enter` jumps to the best match (expanding folders on the way) |
| `v` | `v: view` | Cycle the view for the selected file: diff → full diff → code/markdown |
| `n` | `n: next` | Select the next changed file |
| `p` | `p: prev` | Select the previous changed file |
| `b` | `b: HEAD` / `b: Base` | Flip the diff baseline (merge-base with the default branch ↔ `HEAD`); remembered per repository |
| `c` | `c: changed` / `c: all files` | Show only files with a git status, or the whole tree; remembered per repository |
| `l` | `l: tree\|file` / `l: file\|tree` | Swap the split layout — put the tree on the right or the left; remembered per repository |
| `r` | `r: reload` | Re-read `git status` and the tree immediately |
| `Tab` / `↑` `↓` | — | Walk the toolbar and the tree rows; the tree window follows the focus |
| wheel / `PageUp` `PageDown` | — | Over the tree: move the tree cursor; over the content: scroll the file |
| `Enter` | — | Press the focused control (a folder row expands/collapses) |

Tree rows read as `❯ M   src/x.ts`: selection mark, git mark
(`M` modified, `A` added, `D` deleted, `?` untracked), indentation, then the
name; a folder with changes underneath carries a trailing `~`.

## What the agent should know

- The pane is **read-only**. To change a file, use the normal file tools as
  usual; the tree refreshes after `Edit`, `Write`, `NotebookEdit`, `Bash` and
  `PowerShell` calls finish.
- Diffs compare against `HEAD` by default; `b` switches to the merge-base with
  the default branch. The choice is stored per repository in `$.store`.
- Deleted files only ever render as a diff — there is no content left to show.
- Content longer than 10,000 characters is truncated with `… [truncated]`;
  binary files report `binary file` instead of content.
- Outside a git repository the pane still browses the session directory; the
  status line says `no git repo` and there are no status marks.
