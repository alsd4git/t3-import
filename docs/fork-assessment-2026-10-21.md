# Fork assessment, 21 October 2026

This assessment covers T3 0.1.1, OpenCode, interactive destination selection,
and integration with the personal `codex-thread-normalizer` skill. Work remains
local on `feat/t3-v010-v2-support`. No live metadata was changed and no provider
turn was started. Compatibility inspection used official tagged source and
read-only local database queries. Live cross-application observations are
provisional, since T3 and its Codex runtime were running.

## T3 0.1.1 is not supported by the current writer

The installed application is 0.1.1. Its active `userdata/statev2.sqlite` records
migration 67. Official tag `v0.1.1` resolves to
`fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92`.

The fork currently supports V1 migrations 40–54 and V2 migration 62, using the
official persistence implementation pinned to T3 0.1.0. On the live 0.1.1
database, its validator refused with compatibility exit code 3. Before the
preflight improvement accompanying this report, the message named the missing
`projection_state` table rather than the unsupported migration.

Migration 63 intentionally drops that table and several other V1 projections.
Migrations 64–67 change pull-request links, usage indexing, settlement timestamps,
and webhook deduplication. The tagged EventSink, ProjectionStore, ProjectStore,
event store, and V2 contracts also differ from 0.1.0. Effect is now pinned to
4.0.5 in T3's workspace catalog. Adding 67 to an allowlist is insufficient.

The compatibility work should regenerate a separately pinned 0.1.1 runtime and
schema fixture, separate V1 requirements from current V2 requirements, and audit
every importer query that assumes retained V1 tables. Import, sync, replacement,
ledger recovery, legacy hydration, timeline ordering, rollback and passive
provider references need integration coverage against the new runtime. Preserve
the existing 0.1.0 profile instead of silently replacing its contracts.

The small preflight change only improves the refusal message. It does not enable
0.1.1 writes or modify the supported migration list.
Validation for this change: all 52 tests in `test/schema.test.ts` passed,
including the removed-table regression; `npm run typecheck`, `npm run build`
and `git diff --check` passed. The entire suite was not rerun for this diagnostic
ordering change. The preceding 676-test result concerns the earlier 0.1.0 work.

References:

- [T3 0.1.1 release](https://github.com/pingdotgg/t3code/releases/tag/v0.1.1)
- [Migration 63](https://github.com/pingdotgg/t3code/blob/fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92/apps/server/src/persistence/Migrations/063_DropUnusedV1Projections.ts)
- [V2 event sink](https://github.com/pingdotgg/t3code/blob/fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92/apps/server/src/orchestration-v2/EventSink.ts)

## OpenCode has a usable native integration path

Installed OpenCode is 2.1.2. Its canonical local store is
`~/.local/share/opencode/opencode.db`, with V2 `session_v2` and
`session_message` tables alongside legacy tables. Aggregate inspection found
eight V2 sessions, five with parents, and 310 message records. User, assistant,
idle, system and synthetic records are distinct. The record count is not a count
of completed user turns. Do not parse this as Codex JSONL or use the legacy
tables simply because they still exist.

The installed CLI supports `opencode session export` and `opencode session
import`, including an import directory. Prefer those version-gated transfer
contracts over writing its SQLite tables. The documented HTTP transfer
operations are experimental. Verify import ID preservation/remapping and
append-versus-new-session behavior with isolated fixtures before promising
incremental reverse writes.

T3 0.1.1 includes a native OpenCode V2 adapter, and the local T3 database already
contains an OpenCode provider-thread record. The adapter resolves a session from
`nativeThreadRef.nativeId`; its snapshot records the latest user message as a
weak conversation-head reference. Its capability declaration does not expose a
native turn ID. Consequently, turn grouping and completion detection need an
OpenCode-specific implementation, including idle markers, errors, synthetic
inputs, tool continuations, compaction and child sessions. T3 pins the OpenCode
client/protocol/schema packages to 2.0.28; local CLI 2.1.2 compatibility needs an
actual fixture check rather than an assumed version match.

The fork currently hard-codes Codex/Claude choices in source types, CLI/TUI,
provider selection, resume mapping, native adoption and sync-all. Several
two-way conditionals treat every non-Codex source as Claude. Adding a parser
alone would leave incorrect provider/resume behavior. Replace those policies
with one canonical source/provider definition, without creating a general
plugin framework.

References:

- [OpenCode V2 CLI transfer commands](https://dev.opencode.ai/v2/docs/cli/commands/)
- [OpenCode V2 API](https://dev.opencode.ai/v2/docs/api)
- [T3 OpenCode V2 adapter](https://github.com/pingdotgg/t3code/blob/fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92/packages/provider-opencode/src/server/v2/adapter.ts)

## Define bidirectional behavior explicitly

The existing importer writes into T3. Resuming its original provider session
can make later work available in that provider's native store, but the fork has
no general T3-to-provider transcript writer.

Two supported workflows should be distinguished:

- Continue an existing OpenCode session from either application. Preserve its
  native session ID, import settled missing history into T3, and verify that T3
  continuation updates the same native session. Refresh snapshots explicitly;
  this is not continuous synchronization.
- Transfer a T3-only conversation into OpenCode, including conversations born
  with another provider. Generate the supported transfer format and persist the
  actual resulting session ID and lineage. A provider change is a transfer or
  fork, not proof that two native session identities are interchangeable.

Both need explicit direction, an exact preview, independent checkpoints for
each side, stable message identities and idempotency. If both sides changed
after the last verified checkpoint, stop and preserve both histories. Do not
concatenate by timestamps or match turns only by prompt text. Writes across two
applications cannot be one SQLite transaction: record recoverable operation
state and the destination IDs so a retry cannot create another session.

Test isolated export/import/re-export round trips first, including attachments,
tool content, failed/interrupted turns and parent relationships. Then test a
small real transcript on database copies. Live provider continuation remains a
separate test with explicit scope. No native stores should be overwritten to
simulate a shared conversation.

## Extend the existing interactive mode

The Ink TUI already supports source, workspace, provider, conversation selection,
preview and import/sync/replace results. Destination-project selection currently
requires CLI flags. Extend this TUI rather than introducing another interface.

Add source/direction selection and a destination screen that shows project root,
source cwd and effective target cwd. Reuse the CLI destination validator. Offer
compatible existing projects, a project for the original folder, and native
scratch only when its existing rules allow it. A different cwd must be a distinct
explicit operation, never an incidental effect of choosing a sidebar label.
Preview title changes separately from transcript writes.

## Share evidence with codex-thread-normalizer

Read-only inspection found six direct Codex native-session bindings in the local
T3 database: three top-level conversations and three provider-created subagents.
All six resolve in the active Codex database. All three subagents also have a
Codex agent role and a native spawn edge. Thus this environment currently has
enough evidence to identify them even if Desktop presents them as ordinary
conversation rows. These counts do not establish transcript equality.

The normalizer already requires verified bindings, excludes subagents by
default, and keeps names, transcripts and cwd changes separate. Preserve those
rules. Add an explicit T3-subagent naming scope when implementing integration;
do not import or synchronize child history automatically. Also inspect T3
lineage for delegated children whose Codex role/spawn metadata may be absent.

Expose a bounded read-only JSON reconciliation report from the importer and let
the skill consume it. Keep binding/conflict policy in the importer rather than
copying SQL and identity heuristics into the skill. The report should distinguish
T3 origin from a native conversation merely linked/imported into T3, and include
parent lineage, archive state, cwd, active runtime and evidence quality. A `[T3]`
or `[T3 subagent]` title marker is a naming proposal, not an identity key.

The skill can continue applying approved Codex metadata plans with its existing
backup and index helpers. Require the exact preview and explicit approval;
update title/name/index together, preserve native IDs and spawn edges, and leave
rollouts alone. T3 title changes need their own supported operation and preview.
No rename preview or metadata mutation was performed in this assessment.

## Recommended local sequence and effort

Use our fork as the delivery repository, keep the upstream remote for comparison,
and preserve attribution. Independent commits make later upstream adoption
possible without waiting for it. Do not publish packages or push this work yet.

1. T3 0.1.1 runtime/schema compatibility and regression fixtures: roughly 1–3
   focused engineering days, subject to contract changes found during adaptation.
2. OpenCode V2 discovery, canonical parsing, native import/resume references and
   settled forward sync: roughly 1–2 days after compatibility works.
3. Reverse transfer and synchronization semantics, operation recovery and
   conflict/branch tests: roughly 3–6 additional days. This is the largest and
   least certain part; exact import semantics must be established first.
4. Extend TUI destination/direction review: roughly 1–2 days, reusing the same
   policies and parsers.
5. Reconciliation report and normalizer integration, including opt-in child
   naming: roughly 1–2 days.

These are planning ranges, not delivery promises. The current assessment and
preflight correction do not implement OpenCode support, reverse synchronization,
or the proposed naming integration. Keep each stage locally testable and commit
only validated increments. Avoid splitting into unrelated PRs until the local
contracts and test fixtures are stable.
