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
   - Builds signed `termurl` pacman packages for x86_64 and aarch64 and
     publishes them to the `msegoviadev` repository hosted at
     [msegoviadev/pacman-repo](https://github.com/msegoviadev/pacman-repo)
     (`gh-pages` branch, served at `https://msegovia.dev/pacman-repo/$arch`).

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
Homebrew formula and the signed pacman packages automatically.

The termurl repository must have these Actions secrets:

- `PACKAGES_REPO_PAT`: permission to push to `msegoviadev/homebrew-tap` and
  `msegoviadev/pacman-repo`.
- `PACMAN_REPO_GPG_KEY`: ASCII-armored private half of the key signing the
  `msegoviadev` pacman repository (fingerprint
  `ABD517389B8A1447971AE05F7A1E0EC939A79CBC`, UID
  `msegoviadev (pacman repo) <contact@msegovia.dev>`). The public half is
  published as `msegoviadev.asc` in pacman-repo.

The Homebrew formula and pacman packages must not be updated with placeholder
checksums. The release assets and their checksums must exist first.

## pacman repository

The `msegoviadev` pacman repository is multi-package: any project can reuse
the same `publish-pacman-repo` job, GPG key, and PAT to publish into it.
Users who added the repo once get every package in it via plain `pacman -S`.
Old package versions stay on the `gh-pages` branch, so downgrades via
`pacman -U` against an older package URL remain possible.

`pacman/termurl/PKGBUILD` in this repository is the reference recipe; CI
regenerates it per release with real checksums before running `makepkg`. The
aarch64 package is cross-built without qemu by overriding `CARCH` through a
custom makepkg.conf, which works because the package only wraps a prebuilt
binary. The `options` entry disabling `strip` is load-bearing:
`bun build --compile` embeds the application bundle in the binary and
stripping removes it.

The signing key was generated with:

```bash
gpg --quick-gen-key "msegoviadev (pacman repo) <contact@msegovia.dev>" ed25519 sign never
```

If the key ever rotates, update the fingerprint in this file, in the README,
in `pacman-repo/README.md`, and republish `msegoviadev.asc`.
