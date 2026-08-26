# AGENTS.md

## Commands

- `bun install`
- `bun run tui` - run the app (accepts an optional collection path argument)
- `bun run dev` - watch mode
- `bun run build` - compile a standalone `termurl` binary via `bun build --compile`. Requires Bun >= 1.3.13 on macOS: 1.3.12 shipped a codesign regression and its unsigned binaries are SIGKILLed on launch.
- Release Please runs from `.github/workflows/release.yml` and uses Conventional Commits to create versioned release PRs, tags, and GitHub Releases. `.github/workflows/binaries.yml` publishes macOS ARM64/x64 and Linux ARM64/x64 assets plus `SHA256SUMS`, then updates the Homebrew tap and pushes `termurl-bin` to the AUR; see `RELEASING.md`. `aur/termurl-bin/PKGBUILD` is the reference AUR recipe; its `options=('!strip' '!debug')` is load-bearing because stripping removes the bundle embedded by `bun build --compile`.
- `bun run typecheck` - the only verification gate; CI runs exactly this and nothing else. There are no tests, lint, or formatter.
- `termurl doctor`, `termurl list`, `termurl show`, `termurl env`, and `termurl run` provide the headless CLI for agents and scripts. `termurl run` accepts explicit request names or `.hurl` files in argument order; it does not execute directories.
- Run the script, not bare `tsc`: it passes explicit flags (`--module NodeNext --moduleResolution NodeNext --resolveJsonModule --skipLibCheck`) that override `tsconfig.json` (which says `module: Preserve`, `moduleResolution: bundler`), and only checks `index.ts`.

## External dependency

- Requires the `hurl` binary (v8+) on `PATH`, spawned via `Bun.spawn`. It is not an npm dep. Typecheck passes without it, but running requests fails.

## Architecture

- Entire app is one file, `index.ts` (~1900 lines), the package `module` entry. Uses `@opentui/core` renderables directly; no React despite `jsx` in tsconfig.
- Collection resolution: `~/.config/termurl/config.toml` (respects `XDG_CONFIG_HOME`) is mandatory; a missing config exits with an error suggesting `termurl init`. A CLI arg overrides the collection for a single run, but config must still exist. There is no CWD fallback. Never use `import.meta.url` for paths; it breaks under `bun build --compile`.
- `termurl init` is an interactive installer: prompts for the collection path (default `~/collection`), writes the config, and scaffolds a starter collection (`.env.dev`, `.env.example`, one sample request). It refuses to overwrite an existing config.
- `termurl init --yes [path]` is the non-interactive installer for agents. `termurl doctor` can run without a valid config and reports setup failures as structured checks with `--json`.
- Headless output keeps stdout pipe-safe: `run` writes response bodies or JSON to stdout, while reports and diagnostics go to stderr. Exit codes are 0 for success, 1 for usage/configuration errors, 2 for runtime errors, and 3 for assertion failures.
- `skills/termurl/SKILL.md` documents the minimum agent workflow: doctor, discover, inspect, choose an environment, and run explicitly named requests.
- Flow execution: queued requests are concatenated into one temp `.hurl` file, with `[Options] output:` injected per request to capture bodies. Captures (e.g. `token`) feed later requests in queue order.
- Both `config.toml` and environment dotfiles are parsed by the same hand-rolled `KEY=value` parser (`parseVariables`). Keep both to simple `key = "value"` or `KEY=value` lines; no TOML sections, no multiline values.

## Conventions

- One request per `.hurl` file under the collection; directory path becomes the request name; first `#` comment becomes the description.
- Environments are `.env.<name>` dotfiles in the collection root (dotenv syntax). The filename suffix is the environment name. There are no profiles or `termurl.toml` anymore.
- Secrets and shared variables live in a plain `.env` in the collection root (gitignored). Plain `.env` is not an environment; `environmentNames()` only matches `.env.<suffix>` and skips `*.example`.
- Variable precedence: captures > `.env` secrets > `.env.<name>` file. All variable files use plain `KEY=value`, parsed by the same hand-rolled parser (`parseVariables`); no `HURL_VARIABLE_` prefix anywhere (hurl still reads those natively from the process env, but termurl does not use them).
- The TUI writes files in place: `ctrl-s` saves `.hurl` files and the selected `.env.<name>` file directly.
- Mouse: all text areas are `selectable: true` (click positions the cursor, drag selects; the renderer handles both natively). `TextRenderable` defaults to `selectable: true` in @opentui/core, so list rows, the tab bar, and the status bar must set `selectable: false`, otherwise a plain click starts a drag selection and paints stray highlights. Pane boxes have `onMouseDown` handlers that sync the app's `pane`/`historyPane`/`envPane` state via `setPane`/`setHistoryPane`/`setEnvPane`, guarded by `!== target` so clicks inside an INSERT-mode editor don't exit INSERT. List rows have per-row `onMouseDown` (select; folders toggle; double-click on a request row = `tab` queue toggle, 400ms window via `lastRowClick`).
- Response rendering: JSON bodies are pretty-printed; display is capped at `BODY_DISPLAY_LINES` (2000) lines with a truncation note, and `s` in the response pane writes the full body to `<collection>/.termurl/bodies/`. Failed assert messages are normalized by `normalizeAssertMessage` (title + caret annotation only; hurl's temp-file path and source excerpt are dropped). The response `TextareaRenderable` must keep explicit `width/height: "100%"`; without it a large body inflates its intrinsic height and breaks the flex layout.
- Cursor-follow scrolling: vim key movements go through `editBuffer` methods, which never scroll the viewport, and `editorView.getVisualCursor()` freezes once the cursor leaves the visible area of an unfocused textarea. `ensureCursorVisible` therefore maps the editBuffer's logical cursor row to a visual row via `editorView.getLogicalLineInfo().lineSources.indexOf(row)` (wrap-aware) and drives `setViewport` directly. Do not use `TextareaRenderable.moveCursor*` here: they clear the renderer selection via `updateSelectionForMovement`, and a focused textarea also treats bare keys as text input.
- History is appended to `<collection>/.termurl/history.jsonl` (gitignored; the collection walker skips `.termurl`). History records use the `environment` field; `profile` is kept only for reading pre-rename records.
