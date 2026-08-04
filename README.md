# termurl

Hurl for both humans and agents, powered by plain-text request files.
termurl provides a Bun and OpenTUI interface for running requests, composing
ordered flows, inspecting responses, and editing request and profile files.

## Requirements

- Bun
- Hurl 8 or newer on `PATH`
- Docker, optional, for the local WireMock API

## Quick Start

```bash
bun install
bun run tui
```

The sample collection is under `collection`. Profiles are stored in
`collection/termurl.toml`. Additional request variables can be supplied through
Hurl's `HURL_VARIABLE_<name>` environment variables.

For the local WireMock fixture, copy `.env.example` to `.env` before running
flows that require request variables.

## Local API

Start the deterministic WireMock API used by the `dev` profile:

```bash
cd wiremock
docker compose up -d
```

The API listens on `http://localhost:3000`. Stop it with
`docker compose down` from the same directory.

## Controls

- `1`: workspace
- `2`: history
- `3`: profiles
- `j/k`: navigate the active list
- `ctrl-l` and `ctrl-h`: move between panes
- `enter`: run a request or activate a profile
- `tab`: queue or unqueue a request
- `ctrl-enter` or `ctrl-f`: run the ordered queue as a flow
- `e`: focus the request editor
- `ctrl-s`: save the focused editable file
- `ctrl-p`: cycle profiles
- `q`: quit

The request and profile editors use Vim-style NORMAL and INSERT modes. The
response pane is read-only and supports NORMAL navigation, VISUAL selection,
`yy` line copy, `Y` whole-buffer copy, and terminal clipboard copying.

## Variable Resolution

Request variables are colored by source:

- Profile values are green.
- Environment values are yellow.
- Captures assigned by earlier requests in the ordered flow are blue.
- Unresolved variables are red.

Capture availability follows the order assigned with `tab`.

## Collection Format

- One request per `.hurl` file
- Directory path becomes the request name
- First comment becomes the request description
- `termurl.toml` contains profile variables
- Hurl captures provide flow dependencies such as `token`

Execution history is stored in `.termurl/history.jsonl` and is ignored by Git.
