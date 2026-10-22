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

## Release checklist

1. Update `package.json`, the root package metadata in `package-lock.json`, the
   changelog and versioned installation instructions together.
2. Run `npm ci`, `npm run typecheck`, `npm test`, `npm run build` and
   `npm run package:check` with Node 24. Check the CI matrix for the exact commit.
3. Build the artifact from the committed tree with `npm pack` into
   `artifacts/release-candidate`. Retain the artifact's SHA-256 checksum.
4. Create an annotated version tag and a GitHub prerelease containing the tarball,
   checksum and relevant changelog notes. Do not move published tags.
5. Verify the downloadable artifact matches the local checksum. Keep npm
   publication an explicitly authorized action; a GitHub release does not publish npm.
6. When npm publication is authorized, authenticate an account allowed to publish
   `@alsdd/t3-import`. Publish the verified tarball with
   `npm publish <tarball> --access public --tag latest`. The explicit `latest`
   setting makes the T3-aligned prerelease version the default installation,
   without requiring `@next`. Verify registry metadata and a clean install.
   A published npm name/version cannot be reused for different contents.

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
