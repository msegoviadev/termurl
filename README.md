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

On Arch Linux and Omarchy, install the `termurl-bin` AUR package:

```bash
yay -S termurl-bin

# or on Omarchy
omarchy pkg aur add termurl-bin
```

The AUR package pulls in `hurl` as a dependency.

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
starter request. The config is required. To use another collection for one
session, pass its path when launching the TUI:

```bash
termurl ./my-apis
```

The collection path is only an override for that run. The config must still
exist.

### TUI workflow

1. Browse requests in the workspace window.
2. Press `enter` to run the selected request.
3. Press `tab` to queue or unqueue requests.
4. Press `shift-enter` or `ctrl-f` to run the queued requests in order as one
   Hurl flow.
5. Use `ctrl-l` and `ctrl-h` to move between the request, editor, and response
   panes.
6. Press `2` for execution history or `3` for environments.

Useful controls:

- `j/k`: navigate lists and move the cursor in NORMAL mode.
- `v/V`: enter character or line visual selection.
- `yy`: copy the selected line; `Y`: copy the whole buffer.
- In the request list: `y` copies the request as a runnable Hurl command
  and `Y` copies it as a runnable `curl` command, both with all
  `{{variables}}` rendered to their active values so you can paste and run
  them in any other terminal.
- `s`: save the complete response body to `.termurl/bodies/`.
- `i`: enter INSERT mode in an editor; `ctrl-s`: save the file.
- `v` / `]`: next variant; `[`: previous variant (when the request has any).
- `ctrl-p`: cycle environments.
- `?`: show shortcuts for the current pane; `q`: quit.

Mouse support includes pane focus, cursor positioning, row selection, folder
expansion, double-click queue toggling, and drag selection in text areas.

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

Request names are collection-relative paths without `.hurl`. The suffix is
optional, so `specs/get` and `specs/get.hurl` identify the same request. An
explicit `.hurl` file path inside the configured collection is also accepted.
Directories are never executed implicitly.

Inspect environments and variables:

```bash
termurl env list --json
termurl env show prod --json
```

Values from the shared `.env` file are masked by default. Use `--reveal` only
when exposing a secret is intentional.

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

A collection is a directory of Hurl files. There is one request per `.hurl`
file:

```text
my-apis/
  .env.dev
  .env.prod
  .env                 # shared secrets, ignored by Git
  specs/
    get.hurl
    list.hurl
```

The collection-relative file path becomes the request name. The first `#`
comment becomes its description. Ordered flows are currently supplied as
explicit request arguments; a first-class ordered collection format can be
added later without changing individual request files.

Environments use `.env.<name>` files. Shared secrets use a plain `.env`, which
is not an environment. Variables are parsed as simple `KEY=value` lines.
Variable precedence is captures, then shared `.env` values, then the selected
environment file.

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
`ctrl-s` writes your edits back into the right spot in the file. Queued flows
remember the variant you picked.

In the CLI, append `@variant` to the request name or pass `--variant`:

```bash
termurl run anything/post@bad-payload --env dev
termurl run auth/login anything/post@xml --env dev   # variants work in flows
termurl show anything/post@xml                        # print one entry
```

`termurl list --json` exposes each request's variants.

## Development

```bash
bun install
bun run tui
bun run typecheck
bun run build
```

The only verification gate is `bun run typecheck`. Release Please creates
versioned release PRs from Conventional Commits. See [`RELEASING.md`](RELEASING.md)
for the release and Homebrew automation.
