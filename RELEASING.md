# Releasing termurl

The first release is `v0.1.0`. The version in `package.json` is the source of
truth and is exposed by `termurl --version`.

## Release Process

1. Confirm `version` in `package.json` is `0.1.0` for the initial release.
2. Run `bun install` if dependency metadata changed.
3. Run `bun run typecheck` and `bun run build`.
4. Commit and push the release preparation changes to `main`.
5. Release Please opens the initial `v0.1.0` release PR. Merge it.
6. The release workflow builds binaries for macOS ARM64, macOS x64, Linux
   ARM64, and Linux x64, then creates the GitHub release with `SHA256SUMS`.
7. The binary workflow generates `homebrew-tap/Formula/termurl.rb` with the
   exact release checksums and pushes it to the tap.

## Subsequent Releases

Push Conventional Commits to `main`:

- `fix:` creates a patch release.
- `feat:` creates a minor release.
- `feat!:` or `BREAKING CHANGE:` creates a major release.
- `chore:`, `docs:`, `refactor:`, and `test:` do not create a release by
  default.

Release Please opens a release PR containing the version bump and
`CHANGELOG.md` update. Merging that PR creates the version tag and GitHub
Release, then dispatches the binary workflow. The binary workflow builds and
uploads the four binaries and `SHA256SUMS`, then generates and pushes the
Homebrew formula automatically.

The termurl repository must have a `PACKAGES_REPO_PAT` Actions secret with
permission to push to `msegoviadev/homebrew-tap`.

The Homebrew formula must not be updated with placeholder checksums. The
release assets and their checksums must exist first.
