# termurl

termurl is a terminal-first HTTP client for [Hurl](https://hurl.dev)
collections. The same plain-text request files work in two ways:

- A focused OpenTUI application for humans who want to browse, edit, queue,
  run, and inspect requests.
- A headless CLI for agents and scripts that need discovery, structured output,
  predictable exit codes, and Unix-friendly piping.

## Requirements

- Bun, when running from source or building locally.
- Hurl 8 or newer on `PATH`.

Published binaries are available for macOS ARM64, macOS x64, Linux ARM64, and
Linux x64. Hurl remains an external runtime dependency.

## Install

Install a published release with Homebrew:

```bash
brew tap msegoviadev/tap
brew install termurl
```

On Arch Linux and Omarchy, install from the `msegoviadev` pacman repository
(one-time setup, then updates arrive with `pacman -Syu` / `omarchy update`):

```bash
curl -fsSL https://msegovia.dev/pacman-repo/msegoviadev.asc | sudo pacman-key --add -
sudo pacman-key --lsign-key ABD517389B8A1447971AE05F7A1E0EC939A79CBC

# append to /etc/pacman.conf:
# [msegoviadev]
# Server = https://msegovia.dev/pacman-repo/$arch

sudo pacman -Syu termurl
```

Or on Omarchy, after the one-time setup: `omarchy pkg add termurl`.
The package pulls in `hurl` as a dependency.

Or build from source:

```bash
git clone https://github.com/msegoviadev/termurl.git
cd termurl
bun install
bun run build
```

## TUI

Initialize a collection and its config interactively:

```bash
termurl init
```

The installer defaults to `~/collection`, writes
`~/.config/termurl/config.toml` (respecting `XDG_CONFIG_HOME`), and scaffolds a
`requests/` and `flows/` layout with a starter request. The config is required.
To use another collection for one session, pass its path when launching the
TUI:

```bash
termurl ./my-apis
```

The collection path is only an override for that run. The config must still
exist.

### Configuration

`~/.config/termurl/config.toml` accepts these keys:

- `collection`: path to the hurl collection (set by `termurl init`).
- `environment`: environment selected on startup (defaults to the first one).
- `theme`: set to `system` to follow the active Omarchy theme. On Linux the
  palette is read from the current theme's `colors.toml`
  (`$XDG_STATE_HOME/omarchy/current/theme/colors.toml`), so every stock and
  custom Omarchy theme is supported. On other platforms, or when the file is
  missing, the built-in Tokyo Night palette is used.

Changes to `theme` apply on the next launch.

### TUI workflow

1. Browse requests in the Requests tab.
2. Press `enter` to run the selected request.
3. Press `tab` to queue or unqueue requests.
4. Press `shift-enter` or `ctrl-f` to run the queued requests in order as one
   Hurl flow.
5. Press `2` for the Flows tab to create, edit, and run saved [flows](#flows).
6. Use `ctrl-l` and `ctrl-h` to move between the request, editor, and response
   panes.
7. Press `3` for execution history or `4` for environments.

Useful controls:

- `j/k`: navigate lists and move the cursor in NORMAL mode.
- `v/V`: enter character or line visual selection.
- `yy`: copy the selected line; `Y`: copy the whole buffer.
- In the request list: `y` copies the request as a runnable Hurl command
  and `Y` copies it as a runnable `curl` command, both with all
  `{{variables}}` rendered to their active values so you can paste and run
  them in any other terminal.
- `s`: save the complete response body to `.termurl/bodies/`.
- `a`: create a request/flow or folder (a trailing `/` makes a folder, naming
  follows the `requests/`-relative path); `r`: rename the selected file/folder;
  `d`: delete it (asks to confirm). Renaming or deleting a request updates
  `.flow` references.
- Running moves focus to the response pane (in Requests and in Flows); `escape`
  returns to the list and `ctrl-h` to the editor, so the next run is a key away.
- `i`: enter INSERT mode in an editor; `ctrl-s` or `:w`: save the file.
- `:` opens a vim-style command line in the status bar: `:w` saves, `:wq`/`:x`
  save and close the pane, `:q` closes the pane (or quits from a list), and
  `!` variants discard unsaved changes. Unsaved buffers show a `[+]` marker in
  the pane title and a yellow `[<name> +a -d]` badge (added/removed lines) in
  the status bar, and actions that would discard them (switching requests,
  variants, environments, flows, or quitting) are blocked with a warning instead; a
  blocked quit jumps focus straight to the buffer that needs attention.
- `v` / `]`: next variant; `[`: previous variant (when the request has any).
- `ctrl-p`: cycle environments.
- `1`: Requests, `2`: Flows, `3`: History, `4`: Environments.
- `?`: show shortcuts for the current pane; `q`: quit.

Requests are listed by name only and colored by HTTP method (GET green, POST
blue, PUT yellow, PATCH magenta, DELETE red, HEAD orange, OPTIONS default);
press `?` in the Requests list for the color legend. Queued requests get an
`[n]` prefix.

Mouse support includes pane focus, cursor positioning, row selection, folder
expansion, double-click queue toggling, drag selection in text areas, and
dragging the pane dividers to resize (the highlighted bar also shows a
horizontal/vertical resize cursor on terminals that support mouse pointer
shapes).

The response pane pretty-prints JSON and limits display to 2000 lines. The full
body remains available through the `s` command. Assertion messages are reduced
to the useful failure detail instead of showing Hurl's temporary source file.

## Agent CLI

Agents should use subcommands instead of driving the TUI. The minimum workflow
is documented in [`skills/termurl/SKILL.md`](skills/termurl/SKILL.md).

### Install the skill

No clone needed, just fetch the single `SKILL.md` file.

Claude Code:

```bash
mkdir -p ~/.claude/skills/termurl
curl -fsSL https://raw.githubusercontent.com/msegoviadev/termurl/main/skills/termurl/SKILL.md \
  -o ~/.claude/skills/termurl/SKILL.md
```

OpenCode (requires the `opencode-skills` plugin enabled in `opencode.jsonc`,
e.g. `"plugin": ["opencode-skills"]`):

```bash
mkdir -p ~/.config/opencode/skills/termurl
curl -fsSL https://raw.githubusercontent.com/msegoviadev/termurl/main/skills/termurl/SKILL.md \
  -o ~/.config/opencode/skills/termurl/SKILL.md
```

### Preflight

Check the binary, config, collection, and environments:

```bash
termurl doctor --json
```

If the config does not exist, initialize non-interactively:

```bash
termurl init --yes ~/collection
```

### Discover

List requests as structured data:

```bash
termurl list --json
```

Inspect one request:

```bash
termurl show specs/get
```

Request names are paths under `<collection>/requests` without `.hurl`. The
suffix is optional, so `specs/get` and `specs/get.hurl` identify the same
request. An explicit `.hurl` file path inside the requests directory (including
`requests/<name>`) is also accepted. Directories are never executed implicitly.

Inspect environments and variables:

```bash
termurl env list --json
termurl env show prod --json
```

Keys prefixed with `secret_` are masked by default. Use `--reveal` only when
exposing a secret is intentional.

### Run

Run one request with structured output:

```bash
termurl run specs/get --env prod --json
```

Run one request with its raw body on stdout:

```bash
termurl run specs/get --env prod --quiet | jq .
```

Run an explicit ordered flow. Captures from earlier requests are available to
later requests in the same invocation:

```bash
termurl run auth/login users/me --env dev --json
```

Run a single variant of a request (see [Variants](#variants)):

```bash
termurl run specs/get@bad-payload --env dev --json
```

Run a saved [flow](#flows) by name:

```bash
termurl run auth-check --env dev --json
```

Pass additional variables with repeatable `--var` options:

```bash
termurl run users/me --env dev --var token="$TOKEN"
```

## CLI Contract

Headless commands are designed for pipelines:

- stdout contains only response bodies, flow bodies, or `--json` output.
- stderr contains progress reports, diagnostics, and assertion messages.
- A single text-mode request writes its raw response body without a wrapper.
- Multiple text-mode requests use `==> request/name` separators.
- `--json` returns one object for a single request and an array for a flow.
- Exit `0` means all requests passed.
- Exit `1` means usage or configuration failed.
- Exit `2` means a request could not run.
- Exit `3` means a request ran but failed an assertion.

This makes commands safe to compose with `jq`, `&&`, shell scripts, and agent
tool calls without mixing diagnostics into response payloads.

## Collections

A collection is a directory holding a `requests/` tree of Hurl files and a
`flows/` tree of saved flows. There is one request per `.hurl` file:

```text
my-apis/
  .env.dev
  .env.prod
  .env.example         # template, skipped by environment discovery
  requests/
    specs/
      get.hurl
      list.hurl
  flows/
    auth-check.flow     # saved ordered group of requests
```

The path under `requests/` becomes the request name. The first `#`
comment becomes its description. Ordered groups can be run ad hoc as explicit
arguments, or saved as [flows](#flows) for reuse from the TUI and the CLI.

Environments use `.env.<name>` files. Variables are parsed as simple
`KEY=value` lines. Keys prefixed with `secret_` are masked in the TUI (toggle
with `ctrl-r`) and in `termurl env show` unless `--reveal` is used. Variable
precedence is captures, then `--var` values, then the selected environment
file.

### Variants

One request can offer several header and body combinations without duplicating
the file. Add extra entries to the same `.hurl` file, each marked by a
`# variant: <name>` comment directly above its request line:

```hurl
# Anything echo POST
POST {{host}}/anything/echo
Content-Type: application/json
{"probe":"post"}
HTTP 200

# variant: bad-payload
POST {{host}}/anything/echo
Content-Type: application/json
{"probe":
HTTP 400
```

The first entry is the default. Every variant is a complete entry with its own
headers, body, and assertions, so a variant can expect a different status code.
The file stays valid Hurl: `hurl file.hurl` runs every entry in order.

In the TUI, requests with variants show a `+N` badge on the row and a variant
strip under the request pane listing every variant as a tab. Cycle with `v` /
`]` (next) and `[` (previous), or click a tab. Switching is instant: the
editor immediately shows that entry, so you see the headers and body as you
flip through. The active variant shows on the row as `name@variant`, and
`ctrl-s` (or `:w`) writes your edits back into the right spot in the file.
Queued flows remember the variant you picked.

In the CLI, append `@variant` to the request name or pass `--variant`:

```bash
termurl run anything/post@bad-payload --env dev
termurl run auth/login anything/post@xml --env dev   # variants work in flows
termurl show anything/post@xml                        # print one entry
```

`termurl list --json` exposes each request's variants.

### Flows

A flow is a named, saved, ordered group of requests that runs as one Hurl flow,
so captures from earlier steps are available to later ones. Flows live under
`flows/` at the collection root as `.flow` files, one request per line with an
optional `@variant`, `#` comments ignored, and the first `#` comment used as the
flow description:

```text
flows/auth-check.flow
```

```hurl
# Log in, then fetch the current user
auth/login
users/me
```

The file path minus `.flow`, with the leading `flows/` dropped, is the flow name
(`flows/admin/reset.flow` is `admin/reset`). Steps are resolved exactly like
`termurl run` arguments, so an unknown request or variant is reported before
anything runs.

Run a flow headlessly, or list and inspect them:

```bash
termurl flows list --json
termurl flows show auth-check
termurl run auth-check --env dev --json
```

Explicit requests and flows can be mixed in one invocation and run in argument
order. A name that matches both a request and a flow resolves to the request.
Flow steps without an explicit `@variant` follow the `--variant` flag, and the
environment comes from `--env` (CLI) or the active environment (TUI).

The **Flows tab** (`2`) shows a tree of `flows/` folders and saved flows, and
edits the selected flow directly, with the `.flow` file as the source of truth:

- `j`/`k`, `g`/`G`: move through the tree; the right pane shows the selected file.
- `enter`/`l`: run the selected flow (the response appears in the right-hand
  response pane, and focus moves there), or expand/collapse a folder.
- `a`: create a flow or folder by typing its name inline. A trailing `/` makes
  a folder, and `/` in the middle nests (`admin/reset`).
- `r`: rename the selected flow or folder.
- `d`: delete the selected flow or folder (asks to confirm).
- `e`/`i`: open the flow editor; `i`: open it in INSERT mode.
- In the editor: `ctrl-a` appends the request currently selected in the
  Requests tab as a step, and `:add <request[@variant]>` appends by name.
- `J`/`K`: move the current step down/up (or use the usual `dd`/`p`).
- `ctrl-s`/`:w`: save; `:q`/`:q!`: close the editor; `ctrl-f`: run.
- `ctrl-l`/`ctrl-h`: cycle list, editor, and response panes.
- `ctrl-g` (or `:flows`) still opens a quick picker from the Requests tab, and
  `:saveflow <name>` (`:saveflow!` to overwrite) saves the current `tab` queue
  as a flow.

The **Requests tab** uses the same keys: `a` creates a request or folder, `r`
renames, and `d` deletes. Names are relative to `requests/`, so `a` with `specs/`
creates a folder and `specs/get` creates `requests/specs/get.hurl`. Renaming or deleting
a request rewrites the corresponding step lines in every `.flow` file.

## History

The **History tab** (`3`) lists recent runs, newest first, grouped by day. Each
row shows the kind, the name, the flow step count, and the status:

```text
14:32  REQUEST  httpbin/get  OK
14:31  FLOW  register-a-user  (3 steps)  OK
14:30  QUEUE  (2 steps)  404 FAIL
```

An ad-hoc `tab` queue is shown as `QUEUE`; a saved flow shows its name. The
detail pane repeats the kind and name and lists every step with its status,
duration, captures, request, and response. History is stored in
`.termurl/history.jsonl` and is not committed.

## Development

```bash
bun install
bun run tui
bun run typecheck
bun run build
```

The only verification gate is `bun run typecheck`. Release Please creates
versioned release PRs from Conventional Commits. See [`RELEASING.md`](RELEASING.md)
for the release, Homebrew, and pacman repository automation.
