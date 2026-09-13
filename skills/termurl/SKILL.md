---
name: termurl
description: Run HTTP requests headlessly from a termurl hurl collection: check setup, discover requests, environments, and saved flows, and run requests/flows with variants and captures.
---

# termurl

Use termurl's headless subcommands for agent work; the interactive TUI is not
available to automated workflows.

## Setup

- `termurl doctor --json` checks hurl, config, and the collection. It runs even
  without a valid config and exits non-zero when a check fails, so gate on the
  top-level `ok`; details are under `hurl`, `config`, `collection`, `requests`,
  and `environments`.
- If the config is missing, `termurl init --yes [collection-path]` writes it and
  scaffolds `requests/`, `flows/`, `.env.dev`, and `.env.example`.
- The external `hurl` binary, version 8 or newer, must be on `PATH`.

A collection is a directory: requests live under `<collection>/requests`, saved
flows under `<collection>/flows`, and environment dotfiles (`.env.<name>`) and
`.termurl/` stay at the root. Request and flow files are plain text, so agents
may create or edit them on disk.

## Discover

- `termurl list --json` returns an array of
  `{name, file, method, path, description, variables, variants}`.
- `termurl show <request[@variant]>` prints the raw `.hurl` file, or a single
  entry when `@variant` is given, e.g. `termurl show specs/get@bad-payload`.
- `termurl env list --json` returns an array of environment names.
- `termurl env show <name> [--reveal] [--json]` returns
  `{environment, variables: [{key, value, source, secret, masked}]}`. Keys
  prefixed with `secret_` are masked unless `--reveal` is passed.
- `termurl flows list --json` returns `{name, file, description, steps}`, where
  `steps` are the raw `request[@variant]` lines and `description` is the first
  comment.
- `termurl flows show <name>` prints a flow file.

Naming: a request name is its path under `requests/` without `.hurl`
(`specs/get`); a flow name is its path under `flows/` without `.flow`
(`admin/reset`). A `.hurl`/`.flow` suffix or an explicit file path is also
accepted. A bare name is matched to a request first, then to a flow.

## Run

```bash
termurl run specs/get --env dev --json
termurl run auth/login users/me --env dev
termurl run auth-check --env dev --json          # saved flow by name
termurl run auth/login anything/post@xml --env dev
```

- Positional targets are requests, `request@variant`, saved flows, or file
  paths, run in argument order; requests and flows can be mixed. Captures exist
  only within one invocation and feed later steps.
- `--variant <name>` applies to any request without an explicit `@variant`,
  including flow steps.
- `--var KEY=value` adds a variable, repeatable. Precedence is captures, then
  `--var` values, then the `.env.<name>` file.
- Always pass `--env` for deterministic runs; without it the active environment
  is the first `.env.<name>` (or the `environment` key in config).

Output:

- With `--json`, stdout is a single object for one target or an array for
  several, including status, duration, headers, body, assert counts, and
  captures. Prefer this for agents.
- Without `--json`, one target writes only its response body to stdout; multiple
  targets are separated by `==> <name>` lines. `-q`/`--quiet` keeps the run
  report off stderr.
- `termurl --help` lists every command and option.

## Streams and exit codes

- stdout contains only response bodies, flow bodies, or `--json` output.
- stderr contains run reports, diagnostics, and assertion messages.
- Exit `0` means all targets passed.
- Exit `1` means usage or configuration failed.
- Exit `2` means a target could not run.
- Exit `3` means a target ran but failed an assertion.

Never run bare `termurl` in an automated workflow because it opens the TUI.
