---
name: termurl
description: Run HTTP requests from a termurl hurl collection headlessly, inspect available requests and environments, and chain requests with captures.
---

# termurl

Use termurl's subcommands for agent work. Do not open the TUI from an automated
workflow.

## Setup

Run `termurl doctor` first. If the config is missing, run
`termurl init --yes [collection-path]`. The external `hurl` binary, version 8 or
newer, must be on `PATH`.

## Discover

- `termurl list --json` lists request names, files, methods, paths, descriptions,
  variables, and variants.
- `termurl show <request>` prints the raw hurl file. Append `@variant` to print
  only that entry, e.g. `termurl show specs/get@bad-payload`.
- `termurl env list --json` lists available environments.
- `termurl env show <name>` displays environment variables. Shared `.env`
  secrets are masked unless `--reveal` is explicitly used.

Request names are the collection-relative path without `.hurl`, for example
`specs/get`. A `.hurl` suffix is also accepted. Run requests explicitly, never
by passing a directory.

## Run

Use `--json` when the result needs to be inspected programmatically:

```bash
termurl run specs/get --env dev --json
```

The JSON result includes status, duration, headers, the raw response body,
assert counts, and captured values. A single request returns an object. Multiple
requests return an array.

Without `--json`, one request writes only its raw response body to stdout:

```bash
termurl run auth/login --env dev | jq -r .token
```

Multiple requests run as one ordered flow, so hurl captures from earlier
requests are available to later requests:

```bash
termurl run auth/login users/me --env dev
```

Requests can define variants (alternative headers and body in the same file).
Run one by appending `@variant` to the name, including inside flows:

```bash
termurl run anything/post@bad-payload --env dev --json
termurl run auth/login anything/post@xml --env dev
```

Pass ad-hoc variables with repeatable `--var KEY=value`. Captures exist only
inside one invocation. Use `--quiet` when a response body must be the only
stdout output and the normal report on stderr is not needed.

## Streams and exit codes

- stdout contains only the response body, flow bodies, or `--json` output.
- stderr contains status reports, diagnostics, and assertion messages.
- Exit `0` means all requests passed.
- Exit `1` means usage or configuration failed.
- Exit `2` means a request could not run.
- Exit `3` means a request ran but failed an assertion.

Never run bare `termurl` in an automated workflow because it opens the TUI.
