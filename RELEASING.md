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
7. The binary workflow publishes to both downstream package managers:
   - Generates `homebrew-tap/Formula/termurl.rb` with the exact release
     checksums and pushes it to the tap.
   - Generates `PKGBUILD` and `.SRCINFO` with the exact release checksums and
     pushes them to the AUR package
     [termurl-bin](https://aur.archlinux.org/packages/termurl-bin).

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
Homebrew formula and the AUR `termurl-bin` package automatically.

The termurl repository must have these Actions secrets:

- `PACKAGES_REPO_PAT`: permission to push to `msegoviadev/homebrew-tap`.
- `AUR_SSH_PRIVATE_KEY`: private half of an SSH keypair whose public half is
  registered on the AUR account maintaining `termurl-bin`.

The Homebrew formula and AUR package must not be updated with placeholder
checksums. The release assets and their checksums must exist first.

## AUR one-time registration

The AUR package `termurl-bin` must exist before the workflow can push to it:

1. Create an AUR account and add the public half of a dedicated keypair
   (`ssh-keygen -t ed25519 -f ~/.ssh/aur-termurl`) to the account profile.
2. Add the private half as the `AUR_SSH_PRIVATE_KEY` Actions secret.
3. Push the validated `aur/termurl-bin/` contents (PKGBUILD and .SRCINFO)
   from this repository:

   ```bash
   git clone ssh://aur@aur.archlinux.org/termurl-bin.git
   cp aur/termurl-bin/PKGBUILD aur/termurl-bin/.SRCINFO termurl-bin/
   cd termurl-bin && git add . && git commit -m "Initial termurl-bin" && git push
   ```

   The first push creates the package with the pushing account as maintainer.
   `aur/termurl-bin/PKGBUILD` in this repository is the reference recipe; CI
   regenerates both files per release with real checksums. The `options`
   entry disabling `strip` is load-bearing: `bun build --compile` embeds the
   application bundle in the binary and stripping removes it.
