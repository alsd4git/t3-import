# Usage and safety reference

For installation and the supported release matrix, see the [README](../README.md).

## How it works

`t3-import` reads local Codex conversations through `codex app-server` and Codex rollout JSONL files. It reads Claude Code sessions from the JSONL files under `~/.claude/projects/`. OpenCode 2.x sessions are read from a consistent read-only SQLite transaction in `~/.local/share/opencode/opencode.db`, respecting `XDG_DATA_HOME` or an explicit `OPENCODE_DB`. Legacy OpenCode 1.x sessions are unsupported. The source data is normalized into conversations, turns, messages, tool activity, plans, usage, and supported image attachments.

To keep T3 startup bounded, imports preserve every message, turn boundary, plan, image, error or approval, context compaction, and resume binding while compacting repetitive activity telemetry. Context-window snapshots are omitted, and long turns retain the latest visible reasoning summary plus a representative significant tool activity. The importer rejects any write that would exceed T3's safe one-launch projection budget.

With T3 Code closed, the importer validates the local database and creates a verified backup. V1 imports append events and stopped provider bindings; T3 rebuilds those projections at startup. V2 imports use the pinned official T3 event sink to commit events and projections together. Historical messages do not enqueue provider work. Resumable V2 imports carry native provider-thread references, including Claude's conversation head, and T3 opens the provider session when the user continues. After a successful write, the CLI also backs up and resets T3's rebuildable IndexedDB origin cache so stale task snapshots cannot hide newly imported history.

The default target is `userdata/statev2.sqlite` when it exists, otherwise `userdata/state.sqlite`. The importer never falls back to V1 when a V2 database is incompatible. Writes to the old `state.sqlite` are refused when a sibling V2 database exists. Let T3 perform its upgrade and finish hydrating migrated threads before synchronizing them. Existing importer identities are recovered from retained V1 events; titles and similar paths do not establish identity.

`sync` can append newly settled Codex and OpenCode turns and newly settled turns from linear Claude conversations to imported tasks. It can also adopt a native T3 Codex or OpenCode thread through a unique stopped V1 binding or a V2 native-thread reference, with matching execution cwd and no unfinished V2 work. Before appending, it verifies that the visible user and assistant history is a settled prefix of the provider transcript; a mismatch or ambiguous binding is reported as a conflict. The T3 thread ID and local title are preserved, and the already-visible prefix is not written again. Completed, interrupted, and failed turns are preserved; only genuinely active or indeterminate turns are ignored during synchronization. Claude sessions with multiple non-sidechain leaves after deterministic compaction and retry normalization are reported as conflicts rather than guessed. This is an explicit one-shot sync; it does not watch sessions or synchronize continuously in the background.

If an imported task has diverged or was created by an older importer, `replace` can create a fresh, complete canonical task from the provider transcript. The old task is soft-deleted with a `thread.deleted` event, while its immutable event stream remains available for audit. The provider instance, model, resume cursor, project, and synchronization identity move to the new task atomically. When deterministic normalization reduces a previously fragmented Claude session to one leaf, replacement consolidates every still-visible imported fragment of that session into the new task. Replacement is available for Codex and for Claude sessions with one normalized non-sidechain leaf, and it refuses to snapshot an active provider turn.

## Destinations and interactive mode

Running without a command opens the interactive TUI. It guides you through source, workspace, provider instance, conversation selection, review, confirmation, and results, then offers to start T3 Code with Yes selected by default.

Without an explicit `--workspace`, the TUI shows all discovered working folders.
It does not filter to the current directory or an ancestor of the checkout.
Pass `--workspace <path>` to open that folder's conversation list directly.

For non-interactive `import`, `--workspace` is required and filters source discovery. By default, the destination project is determined by the selected conversation's recorded workspace: the importer reuses a matching T3 project or creates one named after that directory. It does not clone or move the source repository. Omitting `--workspace` does not select T3's "No project" area.

To choose a destination explicitly, pass `--target-project <project-id>` for an existing, non-deleted T3 project. Its root must match the source cwd; otherwise the importer refuses rather than silently changing where resumed work runs. Project IDs can be inspected in the target database with a read-only query such as `SELECT project_id, title, workspace_root FROM projection_projects WHERE deleted_at IS NULL`.

`--no-project` uses T3's native scratch project and keeps the source folder as the thread's `worktreePath`. It requires the source cwd to be an existing direct child of `<t3-home>/scratch`, outside Git checkouts. It refuses external folders and symlinks escaping that layout. It does not move or copy files, create a replacement source folder, or reinterpret an arbitrary directory as managed scratch. The two destination options are mutually exclusive and available through both the interactive TUI and the non-interactive CLI. Preview results include `sourceWorkspace` and `workingDirectory`. Re-importing does not move an existing thread; sync and replacement retain its destination.

Non-interactive examples:

```text
t3-import list --source codex --workspace C:\src\my-project
t3-import show --source claude --thread <session-id>
t3-import import --source codex --workspace C:\src\my-project --thread <thread-id> --yes --non-interactive
t3-import import --source claude --workspace C:\src\my-project --all --since 2026-01-01 --yes --non-interactive
t3-import sync --source codex --workspace C:\src\my-project --thread <thread-id> --yes --non-interactive
t3-import sync --source claude --workspace C:\src\my-project --all --yes --non-interactive
t3-import sync --source codex --all --yes --summary
t3-import replace --source codex --workspace C:\src\my-project --thread <thread-id> --yes --non-interactive
t3-import cache reset --yes
t3-import doctor --json
```

### Synchronize all linked Codex conversations

Close T3 Code, then run `t3-import sync --source codex --all --yes --summary` without `--workspace`. This checks existing provider bindings and import checkpoints across all projects, including scratch workspaces. It does not import unrelated Codex rollouts. Add `--dry-run` to preview without changing the target or import ledger.

Only settled additions after a verified matching history are appended. Streaming message deltas and steered user inputs are reconstructed using the recorded provider turn identity. Existing T3 titles are preserved. Divergent histories, ambiguous bindings, and missing source files are skipped; safe updates in the same batch can still succeed. Exit code 7 reports these skipped cases. Separate branches are not automatically merged or replaced.

Reopen T3 after the command finishes to see the changes. Writes retain the normal database backup and recoverable cache reset. For this development checkout, `bash scripts/sync-all.sh` selects an installed Node 24 through nvm and checks the native SQLite addon before running the same command. Additional flags, such as `--dry-run` or `--json`, can be passed to the script.

See the [validation report](codex-sync-validation.md) for automated tests, database copy checks, live application confirmation, and remaining reconciliation limits.

### Inspect current and historical links

`t3-import links --json` is read-only and does not require closing T3. In a V2
database, `bindings` describes current native or canonical import identities;
`historicalBindings` retains exact V1 resume IDs separately. `mapping: historical`
means a known historical identity exists but no current eligible binding was
found. It does not mean the conversations have equal transcripts or can be synced.
The `--source` filter considers both current and historical identities.

For migrated app threads, `migration.status` distinguishes `legacy-only`,
`continued` with a matching first-run context handoff, and `unverified` when a
current identity exists without that evidence. Historical/current IDs remain
separate even when the report verifies an app-history handoff. Deleted threads
are excluded; archived and child threads remain opt-in. Reports from a running
T3 installation are provisional. This report never changes names or spawn edges.

Global target options can be placed before or after a subcommand:

```text
--t3-home <path>
--db <path-to-database>
--attachments-dir <path>
--provider-instance <id>
--json
--no-color
--no-cache-reset            Keep the existing IndexedDB cache after writes
```

Import options:

```text
--thread <id>             Repeatable; mutually exclusive with --all
--all
--since <ISO date>
--include-incomplete
--dry-run
--yes
--non-interactive
--no-resume
--target-project <id>     Existing T3 project with a root matching source cwd
--no-project              Native scratch destination, only for an existing scratch source cwd
```

Sync options:

```text
--thread <id>             Repeatable; mutually exclusive with --all
--all                     Sync imported tasks and safely adopt matching native Codex threads
--since <ISO date>
--dry-run
--yes
--non-interactive
```

Replace options:

```text
--thread <id>             Repeatable and required for non-interactive use
--dry-run
--yes
--non-interactive
```

The normal TUI labels conversations as new, syncable, up to date, active-only, or conflicted. Interrupted and failed additions are called out in the status text, and ignored active turns are shown without enabling them for synchronization. A history conflict is labeled `history changed · replace available` when it can be replaced. Replacement choices cannot be mixed with imports or ordinary syncs. The dedicated `sync` and `replace` commands open focused TUI flows when required arguments are omitted on a terminal.

The conversation chooser includes counts for new imports, pending syncs, current
history, active-only sessions, conflicts and unavailable sources. Focus a row to
see its next action and the specific reconciliation warning or loading error.
The confirmation screen repeats each selected operation before writing anything.

When `--json` is active, stdout contains one versioned JSON value and diagnostics use stderr. Exit codes are `2` usage, `3` T3 compatibility, `4` safety refusal including live T3 or a corrupt import ledger, `5` source parsing, `6` write failure, and `7` reconciliation conflict.

## Safety and storage

OpenCode continuation through T3 uses the linked native session. T3 0.1.1 also
copies its local title into OpenCode when resuming, so a provider-only `[T3]`
prefix may be overwritten. Provider title normalization is a separate explicit
operation; transcript sync preserves local T3 titles. See the
[live continuation check](continuation-validation-2026-10-22.md).

Before distributing this fork, run `npm run package:check`. It installs the packed
tarball with independent dependencies and checks synthetic import, incremental
sync and idempotency. The same check runs in CI on Node 22/24 and Windows, macOS,
and Ubuntu. See [package validation](package-validation.md).

- Close T3 before every real import. There is deliberately no force bypass.
- Every write creates and verifies a timestamped SQLite backup under `<state-dir>/t3-import-backups/`.
- Automatic backups cover the T3 database and, when reset, its IndexedDB cache. They do not include the external import ledger. Keep a separate consistent ledger backup if you need recovery. If a ledger is corrupt, preserve it and its WAL/SHM sidecars; restore a verified user-maintained backup if available, or investigate recovery before further writes. Do not simply delete it, since it may contain replacement history.
- Successful imports, syncs, and replacements reset T3's rebuildable IndexedDB origin cache by default. The cache is moved aside, copied and verified under the same backup directory before removal; use `--no-cache-reset` to opt out.
- V1 writes append `orchestration_events` and stopped rows in `provider_session_runtime`; T3 projects them at startup. V2 writes use the official event sink and projection stores bundled separately from the pinned 0.1.0 and 0.1.1 sources. The importer does not maintain a second projection implementation.
- V2 operations refuse unfinished runs, pending legacy transcript hydration, ambiguous source bindings, changed native sessions, and source/target cwd mismatches. If verification fails after a committed V2 write, the error explicitly reports that commit and retains its attachments. External-ledger failures are reported separately from the database commit.
- Native Codex adoption requires a unique provider link, an exact working-directory match, and a verified visible transcript prefix. V1 bindings must be stopped; V2 threads must have no unfinished work. Ambiguous or divergent histories are left untouched.
- Imports are idempotent. A second import reports `already-imported`. `sync` only appends completed, interrupted, or failed turns after an unchanged checkpoint, and repeated syncs are no-ops. `replace` promotes one complete new task as the sole synchronization target and soft-deletes the old canonical task; repeating it against that unchanged replacement is also a no-op.
- New imports are rejected when T3 has an existing projection backlog or when the compact event plan exceeds the safe 900-event startup budget.
- Supported local image attachments are copied atomically. Remote images are referenced but not downloaded.
- An external ledger is stored in the platform application-data directory. Event IDs provide the fallback idempotency check if the ledger is missing.

`doctor` reports database compatibility and integrity, live/stale runtime state, discovered IndexedDB caches, source availability, and attachment staging leftovers without changing anything. `t3-import cache reset` can perform the same recoverable cache reset without importing, synchronizing, or replacing anything. Both operations require T3 to be closed.

## Source behavior

Codex discovery prefers the normalized `codex app-server` API and augments it with rollout JSONL; it falls back to rollout files when app-server is unavailable. Claude discovery streams project JSONL and reconstructs its UUID graph. Automatic compaction roots are reconnected through validated `logicalParentUuid` links, and unambiguous successful API-retry forks are linearized while retaining their retry activity. Genuine alternate Claude leaves that remain become separate historical T3 tasks; only the current leaf receives a resume binding.

Injected system/developer/environment envelopes and encrypted reasoning blobs are excluded. Visible messages, reasoning summaries, plans, tools, usage, compaction, resolved approvals/input, and supported images are mapped to T3-compatible events.

## Development

The repositories under `repos/` are references and are not runtime dependencies.

```text
npm install
npm run typecheck
npm test
npm run build
npm pack
```

V1 compatibility uses pinned historical T3 commits for migrations 40–54. V2 is pinned to stable `v0.1.0`, commit `81493efb71e8e8244f95d3e9f71d8369654ab151`, at migration 62. Stable `v0.1.1` is pinned separately to `fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92`, at migration 67. Intermediate migrations 55–61 and 63–66 and unvalidated future migrations fail closed. Production import/sync never upgrades a database; T3 owns that migration.

`npm test` uses committed schemas generated from T3's actual migrations. The additional integration matrix runs the historical event decoders, projectors, and provider restoration services against synthetic databases:

```text
npm run test:compatibility
```

This requires Git, tar, Node.js 22.21.1 or newer, network access for isolated development dependencies, and a T3 checkout containing the pinned commits at `repos/t3code` (override with `T3_REFERENCE_REPO`). It prepares source snapshots under `artifacts/compatibility`, exercises both providers at all fifteen migrations and every upgrade to 54, and writes a JSON result report. Provider processes are replaced with controlled test adapters; no paid provider work runs. The installed T3 application and live database are not used.

V2 integration tests run the bundled official event sink, projection stores, migrations, and legacy importer on synthetic databases. They do not start provider CLIs or modify the installed app. Regeneration of the vendored runtime is an explicit development step, not part of installation or normal builds:

```text
npm run vendor:v2
npm run compat:v2-schema
npm test -- test/v2.test.ts
```

See [compatibility validation](compatibility.md) for pinned references, vendoring provenance, and the exact validation boundary.
