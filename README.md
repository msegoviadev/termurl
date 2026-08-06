# termurl

Hurl for both humans and agents, powered by plain-text request files.
termurl provides a Bun and OpenTUI interface for running requests, composing
ordered flows, inspecting responses, and editing request and profile files.

## Requirements

- Bun
- Hurl 8 or newer on `PATH`
- Docker, optional, for the local WireMock API

## Setup

termurl requires a config file and exits with an error if it is missing.
Create it with the interactive installer:

```bash
termurl init
```

The installer asks for a collection path (default `~/collection`,
press enter to accept, or pass a path: `termurl init ./my-apis`), writes
`~/.config/termurl/config.toml` (respects `XDG_CONFIG_HOME`), and scaffolds a
starter collection. To use a different collection for a single run, pass it as
an argument: `termurl ./my-apis`.

## Quick Start

```bash
bun install
bun run tui init ./collection
bun run tui
```

A sample collection lives under `collection`. Environments are dotenv files in
the collection root: `.env.dev` defines the `dev` environment, and its
variables load when that environment is active. Secrets and shared variables
go in a plain `.env` in the collection root (gitignored, overrides environment
files); see `collection/.env.example`. All files use plain `KEY=value` lines.

To build a standalone binary:

```bash
bun run build
```

## Installation

Published releases can be installed with Homebrew:

```bash
brew tap msegoviadev/tap
brew install termurl
```

The release workflow publishes standalone binaries for macOS ARM64/x64 and
Linux ARM64/x64. See `RELEASING.md` for the tagged-release process.

## Headless CLI

Agents and scripts should use subcommands instead of driving the TUI:

```bash
termurl doctor
termurl list --json
termurl run specs/get --env dev --json
```

Available commands:

- `termurl doctor [--json]` checks hurl, config, collection, and environments.
- `termurl list [--json]` discovers collection-relative request names.
- `termurl show <request>` prints the raw `.hurl` file.
- `termurl env list [--json]` lists environments.
- `termurl env show <name> [--reveal] [--json]` displays variables, masking
  shared secrets by default.
- `termurl run <request...> [--env name] [--var KEY=value] [--json]` runs the
  explicitly named requests in argument order. A `.hurl` suffix is optional;
  directories are not executed.

In text mode, a single `run` writes the raw response body to stdout. For a flow,
each body is preceded by its request name. `--json` writes one object for a
single request or an array for a flow. Reports and errors go to stderr, so
response bodies can be piped safely. Exit codes are 0 for success, 1 for usage
or configuration errors, 2 for runtime errors, and 3 for assertion failures.
See `skills/termurl/SKILL.md` for the minimum agent workflow.

## Local API

Start the deterministic WireMock API used by the `dev` environment:

```bash
cd wiremock
docker compose up -d
```

The API listens on `http://localhost:3000`. Stop it with
`docker compose down` from the same directory.

## Controls

- `1`: workspace
- `2`: history
- `3`: environments
- `j/k`: navigate the active list
- `ctrl-l` and `ctrl-h`: move between panes
- `enter`: run a request, open run details, or activate an environment
- `tab`: queue or unqueue a request
- `ctrl-enter` or `ctrl-f`: run the ordered queue as a flow
- `e`: focus the request editor
- `ctrl-s`: save the focused editable file
- `ctrl-p`: cycle environments
- `q`: quit

The request and environment editors use Vim-style NORMAL and INSERT modes. The
response pane and history run details are read-only and support NORMAL
navigation, VISUAL selection, `yy` line copy, `Y` whole-buffer copy, and
terminal clipboard copying.

Mouse: clicking a pane focuses it (orange border), clicking inside a text area
moves the cursor there, and click-drag selects multiple lines. In the request
list, a single click selects a row (folders expand/collapse) and a double-click
queues/unqueues the request for a flow, like `tab`.

JSON response bodies are pretty-printed. Bodies longer than 2000 lines are
truncated in the pane with a note; press `s` in the response pane to write the
full untruncated body to `<collection>/.termurl/bodies/`. Failed assert
messages are reduced to the essential `Assert ...: actual value is <...>`
instead of hurl's full source excerpt.

## Variable Resolution

Request variables are colored by source:

- Environment file (`.env.<name>`) values are green.
- Secret values (`.env` in the collection root) are yellow.
- Captures assigned by earlier requests in the ordered flow are blue.
- Unresolved variables are red.

Capture availability follows the order assigned with `tab`.

## Collection Format

- One request per `.hurl` file
- Directory path becomes the request name
- First comment becomes the request description
- `.env.<name>` files define environments and their variables
- `.env` holds secrets shared across environments (never committed)
- Hurl captures provide flow dependencies such as `token`

Execution history is stored in `.termurl/history.jsonl` and is ignored by Git.
