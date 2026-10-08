# file-viewer — Claude Code mod (★C adapter)

A git-aware, **read-only** file viewer for Claude Code: `/files [path[:line]]`
opens a pane with the repository tree on the left and the file's content on the
right — a diff when it changed, rendered markdown for `.md`, highlighted code
otherwise. Behaviour follows `ARCHITECTURE.md` §5; the mods API reference is
`docs/claude-code-mods-api.md`.

## Requirements

- Claude Code **≥ 2.1.287** (mods are early access; this adapter was validated
  and tested against 2.1.293). Upgrade with `claude update`.
- A terminal; the pane opens at any width because a person asked for it
  (`/files`), and withdraws itself if the engine reports `isPlaced: false`.

## Run it

```bash
node scripts/sync-core.mjs              # copy core/src → hooks/core (core is the source of truth)
claude --plugin-dir ./adapters/claude-code
```

then type `/files` (optionally `/files src/x.ts:42`) inside a repository.

## Layout

```
.claude-plugin/plugin.json   manifest: name, version, description
hooks/hooks.json             {"description": "git-aware file viewer", "modules": ["./register.ts"]}
hooks/register.ts            register(on, options): every hook, the only file that touches $
hooks/model.ts               module-level model, refresh/selection/actions, $.store preferences
hooks/pane.ts                pure drawing: model + rows + size → element tree
hooks/host.ts                core Host over the Engine closures ($.fs / $.process.run + SAFE git flags)
hooks/core/                  sync-core output — never hand-edit; rerun the script instead
tests/*.test.ts              claude plugin test suite
skills/file-viewer/SKILL.md  teaches the agent how to open and drive the pane
```

`register.ts` builds one `Engine` object of closures over `$` (`engineOf`) and
hands that object to `model.ts` / `host.ts`. The validation rules allow `$` to
be passed only to a top-level function of the same file, so nothing else ever
sees it.

## Keys

| Key | Button | Action |
| --- | --- | --- |
| `f` | `f: find` | Fuzzy-find a file (`Input`, `autoFocus`); `Enter` selects the best match |
| `v` | `v: view` | Cycle `diff → fullDiff → code/markdown` for the selected file |
| `n` | `n: next` | Next changed file |
| `p` | `p: prev` | Previous changed file |
| `b` | `b: HEAD` / `b: Base` | Flip the diff baseline; saved per repository |
| `c` | `c: changed` / `c: all files` | Changed-only filter; saved per repository |
| `l` | `l: tree\|file` / `l: file\|tree` | Swap the split layout (tree ↔ content sides); saved per repository |
| `r` | `r: reload` | Refresh `git status` + tree now |
| `Tab` `↑` `↓` | — | Walk controls; the tree window follows the focus ring (`ui.focus`) |
| wheel, `PageUp`/`PageDown` | — | Pointer over the tree moves the tree cursor; over the content it scrolls the file (`ui.scroll` answered by the mod) |
| `Esc` | — | Closes the pane (`closeOnEscape: true`) |

Tree row labels are `❯ M   src/x.ts`: selection mark, git mark
(`M`/`A`/`D`/`?`), indentation, expansion caret for folders, name; a folder with
a changed file underneath ends in `~`.

## Behaviour notes

- **Data flow**: one module-level model. `redraw()` coalesces redraws through
  `$.clock.after(120)` → `$.ui.invalidate('ui.render')`; `ui.render{Pane}`
  rebuilds the whole element tree from the model (single direction of data
  flow, as in the built-in diff mod).
- **Refresh**: `session.start` (initial load), `command.run{files}` (awaited
  before `$.ui.open`, so the pane never lands on a loading state), and
  `tool.call{Edit,Write,NotebookEdit,Bash,PowerShell}` — `scheduleRefresh()` is
  debounced and serialised with `isRefreshing` / `isRefreshQueued`.
- **Repo root**: `git rev-parse --show-toplevel` from the session cwd, falling
  back to the cwd when the session is not in a repository. Core paths are
  repo-root-relative POSIX; `host.ts` turns them into absolute paths for
  `$.fs`, so `session.cwd() ≠ repo root` needs no special case.
- **Git safety**: every git call is `['git', ...SAFE_GIT_FLAGS(isWindows),
  ...args]` with `env: SAFE_GIT_ENV` (`GIT_OPTIONAL_LOCKS=0`), no shell, argv
  arrays only — `$.process.run(argv, { cwd, env })` accepts both.
- **Windows**: `isWindows` is derived from the session cwd (`C:/…` or
  backslashes); `SAFE_GIT_FLAGS` then uses `core.hooksPath=NUL`.
- **Preferences**: `baseline`, `changedOnly` and the changed-file view
  preference live in `$.store` under `file-viewer:<repo-root>:<name>`.
- **Degrade**: a failed refresh clears the tree and puts the reason on the
  status line; `ui.render` carries a `.catch` that draws a one-line notice, and
  every gating hook has one (required by `claude plugin validate --strict`).

## Development

```bash
node scripts/sync-core.mjs                       # after any core/ change
claude plugin validate --strict ./adapters/claude-code
claude plugin test ./adapters/claude-code        # 14 tests, no sign-in needed
claude --plugin-dir ./adapters/claude-code       # load + hot reload
# in-session: /reload-plugins
```

## Known limitations

- **`n`/`p` stand in for `]`/`[`**: a mod hotkey must be one digit or one
  lowercase letter, so `]` and `[` cannot be bound. `v` is a cycle, not a
  toggle; the changed-file view preference is persisted but has no key yet.
- **Content is windowed by lines.** The drawn tree always fits the pane (that
  is what keeps `↑`/`↓` moving the focus instead of scrolling the pane away
  from the toolbar), so long files are read a screen at a time; the header
  shows `L<first>-<last>/<total>`.
- **Markdown above the window** is truncated by the 10,000-character element
  cap (`… [truncated]`); a markdown line wider than its column wraps and can
  push the drawing one row past the pane.
- **Dotfiles are hidden** (core's `DEFAULT_TREE_OPTIONS.hideHidden`); there is
  no toggle, so `/files .github/…` reports `hidden path`.
- **No mouse selection, no annotations, no editor hand-off** — those are herdr
  features (see the reference repository) and are out of scope for v0.1.
- Content above 200,000 characters is cut; binary files show `binary file`.
- The pane tracks the repository root for the whole session; `/cd` into another
  directory does not re-root it (start a new session or `/files` again after
  moving).
