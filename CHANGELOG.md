# Changelog

## 0.1.7-alsd.1

- Support T3 0.1.7 migration 79 with the pinned official persistence runtime and
  isolated Effect 4.1.2, retaining earlier supported releases.
- Respect outstanding delegated run-cohort deliveries during activity inspection
  and per-thread write checks, including terminal origin runs.
- Validate populated 0.1.6-to-0.1.7 upgrades and one-time schedule activity.
- Derive packed validation's runtime and migration from the release profile.

- Fix an unsettled-await exit when Codex discovery closes a compressed rollout
  early under stream backpressure.
- Report busy sync targets individually during read-only previews, preserving
  the unfinished-work refusal for real writes.
- Add read-only `rename-plan` to prepare native MCP title calls with the current
  thread identity and title. Application remains through T3's supported MCP tool.
- Allow import, sync and replace dry-runs while T3 is running, using read-only
  SQLite snapshots. Real writes still require T3 to be closed or explicitly paused.
- Remove confirmation requirements for dry-runs and reject incomplete selections
  instead of silently opening the interactive write UI.

## 0.1.6-alsd.1

- Support T3 0.1.6 migration 76 with the pinned official persistence runtime,
  retaining earlier supported releases.
- Preserve project pin/archive state during import, sync and replacement.
- Respect updated FTS triggers that exclude attachment-only placeholder prompts
  without removing their transcript content.
- Refuse service pause and affected thread sync/replace when terminal app-owned
  tasks still have pending or claimed completion deliveries. Historical/native
  tasks without delivery metadata remain idle.
- Batch ledger schema upgrades in one durable transaction and stabilize Windows
  integration checks without retries.

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
