# Fork maintenance and releases

`alsd4git/t3-import` maintains its own `main` and releases. The original project is
[CarlosGtrz/t3-import](https://github.com/CarlosGtrz/t3-import). Keep the upstream
remote for review and selectively integrate relevant future changes.

## Integration history

The first fork release starts at upstream commit `5e20fb5` and consolidates the
validated development branch ending at `0c9cf75` into four consecutive blocks:

| Original range | Integrated scope |
| --- | --- |
| `5e20fb5..f09cb9a` | Migration 54, native Codex adoption, cross-workspace sync, ledger safety and destinations |
| `f09cb9a..b8a25c0` | Pinned T3 0.1.0 runtime and safe V2 import/sync |
| `b8a25c0..b91f294` | T3 0.1.1, OpenCode, interactive destinations and discovery |
| `b91f294..0c9cf75` | Link evidence, TUI diagnostics and cross-platform package validation |

The resulting tree was checked against `0c9cf75` before fork metadata and
documentation changes. Original commits remain on `feat/t3-v010-v2-support` and
the existing upstream PR branches. Do not rebase, delete or force-push those
branches as part of fork maintenance. Their squash commits are different Git
identities, so do not merge those old branches back into `main` wholesale.
Start new work from this fork's `main`.

The root package's npm install-script approvals are pinned to the locked
`better-sqlite3` and `esbuild` versions. Review and update those entries when
intentionally changing the corresponding lockfile versions. No blanket script
approval is required.

Keep original authorship and bundled license notices. Update fork repository,
issue and installation links without rewriting historical validation reports.

## Release process

Update `package.json`, its root entry in `package-lock.json`, the changelog and
versioned installation instructions together. Push the commit to `main` and
wait for all six Windows, macOS and Ubuntu Node 22/24 CI jobs to pass. Then push
an immutable tag exactly matching the package version, such as
`v0.1.2-alsd.1`. The tag workflow verifies the tag, package name, lockfile and
that its commit is on `origin/main` before creating a release artifact.

After CI passes, the workflow builds one npm tarball, SHA-256 checksum and
changelog notes, then uploads those files as the `release-<tag>` workflow
artifact before publication. It publishes that exact tarball publicly under
`latest` with npm provenance. On success, it creates a regular GitHub release marked Latest, with
the same tarball and checksum. A rerun skips npm only when the already published
version has identical SHA-512 integrity. Existing GitHub release assets are
downloaded and byte-compared; mismatches stop the workflow, and missing assets
are added without replacing existing ones. Do not move or reuse published tags
or package versions.

### Configure npm trusted publishing once

On the npm package settings for `@alsdd/t3-import`, add a trusted publisher with
these exact values:

- Provider: GitHub Actions
- Owner: `alsd4git`
- Repository: `t3-import`
- Workflow file: `ci.yml` in `.github/workflows`
- Environment: leave blank

The workflow uses npm 12.2.0, which supports trusted publishing and provenance.
Enable direct publishing for the package: npm's current default is staging-only,
and this workflow runs `npm publish` directly. No npm token or repository npm
secret is used. The publishing job receives `id-token: write`; only the GitHub
release step receives `GH_TOKEN` from `github.token`.

The publish job runs only for a `v*` tag push in `alsd4git/t3-import`, after all
six test jobs pass. npm publication is therefore part of the authorized tag
release workflow. A published npm name/version cannot be reused for different
contents.

Versions use `<T3 version>-alsd.<revision>`, starting at `0.1.1-alsd.1`.
Increment the suffix for importer changes against the same latest validated T3
release. Change the T3 portion only after validating that T3 version; continue to
list earlier supported versions in the compatibility matrix. The scoped package
name is
`@alsdd/t3-import`, while the command, ledger directory, synchronization keys
and event identities retain `t3-import`. Renaming package metadata must not reset
the user's synchronization identity or storage.

GitHub description and topics should describe local import/sync for Codex, Claude
Code and OpenCode. Preserve the fork relationship and leave upstream PRs open.
