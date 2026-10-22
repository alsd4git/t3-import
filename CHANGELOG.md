# Changelog

## 0.1.1-alsd.1

First release from the maintained `alsd4git/t3-import` fork. Package name:
`@alsdd/t3-import`; executable: `t3-import`. Version numbers follow the latest
supported T3 release plus an independent
fork revision. GitHub releases provide a tarball; npm publication uses the
default `latest` channel.

- Support T3 V1 migrations 40–54 and pinned T3 0.1.0/0.1.1 V2 migrations 62/67.
- Import and sync OpenCode 2.x sessions into T3, preserving native session identity,
  working directory, model and variant.
- Safely adopt linked Codex/OpenCode conversations and sync across working folders.
- Select compatible destination projects in the CLI and TUI, including eligible
  managed scratch folders.
- Explain sync states, conflicts, ignored active turns and source inspection errors.
- Report current bindings, historical V1 identities and verified V2 context handoffs.
- Validate packed installs, synthetic import/sync and idempotency across Windows,
  macOS and Ubuntu on Node 22/24.
- Provide fork documentation and reproducible synthetic TUI captures.

Provider history flows into T3 only. Unknown database schemas fail closed. Existing
upstream PR branches remain unchanged; this release does not merge or rewrite them.
