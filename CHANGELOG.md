# Changelog

## 0.1.5-alsd.1

- Support T3 0.1.4 and 0.1.5 migration 72 using their pinned official persistence
  runtimes, retaining earlier supported releases.
- Preserve peer-link configuration and thread link-origin metadata during sync.
- Treat waiting environment-link requests and remote tasks with owed stops as
  unfinished work, refusing automatic service pause and affected thread sync/replace.
- Verify message search, recovery backups and the installed package on schema 72.

## 0.1.3-alsd.1

- Support T3 0.1.3 migration 69 with the pinned official persistence runtime,
  retaining compatibility with earlier supported versions.
- Validate optional FTS5 message search and its maintenance triggers; test
  search results after import, sync and replacement.
- Preserve message rowids in SQLite recovery backups so restored search indexes
  continue to reference the correct messages.

## 0.1.2-alsd.1

- Read Codex `.jsonl.zst` rollouts directly, preserving content fingerprints and
  preferring the matching plain rollout when both coexist.
- Validate T3 0.1.2 with the pinned official persistence runtime. It shares
  migration 67 and identical schema DDL with 0.1.1; both releases remain covered.
- Align the npm engine constraint with the documented Node.js 22.21.1+/24+ support.
- Report persisted T3 activity and verified Linux systemd service ownership with
  `runtime status`, including pending runs, approvals, background work and schedules.
- Offer explicit idle-service maintenance through the TUI or `--manage-runtime`.
  Restore the same service after success, cancellation or error; refuse busy,
  unknown or ambiguously managed instances.

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
