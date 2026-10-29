# T3 compatibility validation

The importer supports V1 database migrations 40–54 and T3 V2 migrations 62, 67, 69 and 72 explicitly. A supported number
must also pass integrity and required-column checks. This is not a promise that
every future T3 commit retaining the same migration number will remain compatible.

## T3 0.1.4–0.1.5 / migration 72

Migration 70 adds `peer_environment_links`, migration 71 adds its `fenced`
column, and migration 72 indexes waiting link-request turn items. Both official
release schemas generate identical DDL and normalized migration history. The
migration 72 writer uses `vendor/t3-v015`; `vendor/t3-v014` remains a test
reference. Both use Effect 4.0.5 through the existing dependency alias.

Peer configuration is preserved. Sync retains thread `linkOrigin` and
`delegatedFrom` metadata through the official event sink. Waiting link requests
and remote delegated tasks with undelivered stop requests count as unfinished
work, including tasks that already have a result. Service maintenance refuses
to pause in these states; synchronization and replacement refuse affected
threads. See the [0.1.5 validation record](v015-validation.md).

## T3 0.1.3 / migration 69

The migration 69 writer pins `v0.1.3` to
`d2c440312e5f39d59827ed466838a623516454d6` in `vendor/t3-v013`.
Migration 68 adds the shell stop-request index; migration 69 adds optional
FTS5 message search and its insert/update/delete triggers. Validation accepts
T3's supported fallback without the search extension, and refuses a present
index with missing maintenance triggers or shadow-table columns.

Recovery backups use SQLite's backup API to preserve message rowids referenced
by the contentless search index. The integration matrix retains all earlier
release runtimes. See the [0.1.3 validation record](v013-validation.md).

## T3 0.1.1–0.1.2 / migration 67

The migration 67 writer pins `v0.1.2` to
`044f07257c9684ae4543bd1e1ebf9c394e9e3830` in `vendor/t3-v012`. The earlier
`v0.1.1` reference (`fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92`) remains in
`vendor/t3-v011` for compatibility tests. Both use Effect 4.0.5, installed under
the existing `effect-v011` alias. The 0.1.0 runtime retains Effect 4.0.4.
Selection uses the validated database migration, never the installed app's
display version alone.

T3 0.1.2 adds no migrations. Every executable migration file is unchanged from
0.1.1, and schema generation verifies identical DDL and normalized migration
history before sharing profile 67. The generator refuses releases that claim
the same migration but produce different schemas. The new runtime includes the
0.1.2 EventSink outcome metrics and optional approval/shell fields; import and
sync are tested against all three pinned official runtimes. See the
[0.1.2 validation record](v012-validation.md).

Migration 63 drops unused V1 projections including `projection_state`. V2
validation uses its own full column manifest and migration names through 67;
V1 still requires its replay cursors. Intermediate migrations 63–66 remain
unsupported. New schema generation and vendoring are explicit development steps:

```text
node scripts/v2/build-runtime.mjs 0.1.1
node scripts/v2/build-runtime.mjs 0.1.2
npm run compat:v2-schema
```

OpenCode 2.x imports carry a strong native session reference and a weak user
message head reference. Terminal user IDs and exact visible content/status are
checked before native history is adopted. No reverse transcript writer is
implemented. See [the implementation validation](v011-opencode-validation.md)
for the real-data copy test, package checks and provider-continuation limits.

## T3 0.1.0 / Orchestrator V2

V2 is pinned to `81493efb71e8e8244f95d3e9f71d8369654ab151`, the official
`v0.1.0` tag. Migration 55 introduces V2 and migration 62 is the release's
latest migration. Intermediate V2 previews are not supported. Validation checks
the complete required-column manifest and the names of migrations 55–62,
not just the highest migration number.

When present, `userdata/statev2.sqlite` is selected ahead of `state.sqlite`.
An incompatible V2 database is an error, not a reason to modify the retained V1
copy. An explicit V1 target with a sibling V2 database is also refused for writes.
`--db` still selects an explicitly supplied database; isolated older homes remain
supported.

V2 has no V1-style startup replay contract for offline event-only writes. The
importer therefore ships the official event sink, event store, projection stores,
and their dependencies as `vendor/t3-v010/runtime.mjs`. Effect is pinned to the
release's `4.0.4`. Only these persistence components are used; no server, provider
adapter, reactor, or outbox worker is started. Importer code reserves historical
turn-item positions before sink normalization, following the upstream legacy
importer's pattern, so incremental history follows existing native runs.

The shared import plan maps to passive V2 conversation messages and timeline
items. It creates no queued historical runs or executable outbox work. Tool
activities without a direct V2 representation retain their payload as a system
notice. Proposed plans appear as historical timeline items. Native provider
threads use `not_loaded` references rather than fabricated runtime sessions;
Claude's `resumeSessionAt` becomes a separate conversation-head reference.
Completed turns retain their terminal metadata by updating the final timeline
item unchanged, without adding a visible completion warning. Failed and
interrupted turns retain a visible notice. Existing imported notices are not
rewritten by this change.

V1 cutover recovery uses retained canonical importer event IDs and replacement
metadata. T3's `migration:v1:*` transcript copies are not counted twice. Pending
legacy hydration, unfinished V2 work, duplicate bindings, provider rebinding,
and changed execution cwd block reconciliation. Native Codex adoption compares
provider-turn identity, terminal status, exact visible text, and attachments.
Unfinished effects/background tasks also block writes, and provider-managed
native subagents are excluded. Title similarities never establish a source link.

The official sink commits a whole importer batch, its projections, and timeline
position reservations in one SQLite transaction. External-ledger updates remain
separate and recoverable from event metadata/checkpoints. An error after a V2
commit reports that fact and preserves copied attachments. The normal verified
database backup is created before the transaction.

`test/v2.test.ts` exercises both providers' import/sync/replacement, ledger
recovery, native Codex prefix adoption, the official V1 cutover, transaction
rollback, dry-run safety, title preservation, native rebinding, unfinished work,
and scratch cwd preservation. The V1 cutover test seeds frozen V1 projection
rows, then runs T3's actual migrations and legacy importer. This does not
retest V1 projection replay. No test in this suite invokes paid providers or
establishes that the installed app's UI or provider CLI continuation was tested.

To regenerate the runtime, run `npm run vendor:v2`. The script downloads the
pinned source archive, verifies its SHA-256, extracts a fresh development copy,
and installs the separately locked build dependencies with lifecycle scripts
disabled. It bundles official code and includes its MIT license and third-party
notices. `T3_V2_SOURCE_ARCHIVE` can select an already-downloaded archive; its
checksum must still match. `reference.json` records the pin and archive digest.
Normal builds and package installation use the committed bundle without network
access. `npm run compat:v2-schema` regenerates only the migration-62 fixture;
`npm run compat:schemas` regenerates the historical fixtures and V2 together.

See [the V2 validation report](v2-validation.md) for the checks run on this branch
and the boundaries of the live-provider validation.

## Pinned references

Each historical reference below has the stated migration as its latest migration.
Full commit IDs and matching Effect versions live in
[`references.json`](../scripts/compatibility/references.json).

| Migration | Reference commit | Migration change |
|---|---|---|
| 40 | `076e9048dc57` | Project favicon path |
| 41 | `11f051373e79` | Auth session client connection |
| 42 | `3c75eb1132bb` | Thread-linked pull request |
| 43 | `3b86ef941c21` | Unsettled thread timestamp |
| 44 | `5392c9bb99c4` | Clear automatic project model defaults |
| 45 | `ba3cb0773859` | Project auto-pull |
| 46 | `2971ec3209d7` | Repair automatic settlement timestamps |
| 47 | `f6c04c552c20` | Project icons |
| 48 | `223ff4490f76` | Branch pull request |
| 49 | `2d645df474f0` | Active thread ordering |
| 50 | `b7b3ef1e6fcb` | Multiple thread pull requests |
| 51 | `4fed6cfb3517` | Message context |
| 52 | `719a76ca1dbf` | Thread title state (stable v0.0.42) |
| 53 | `adcd90858c3b` | Pull request files viewed (nightly 20260920.2031) |
| 54 | `451afcb22d93` | Per-thread auto-settle switch (stable v0.0.44) |

The migration-50 reference is nightly `v0.0.41-nightly.20260910.1473`.
The migration-52 reference is stable `v0.0.42`; migration 53 is nightly
`v0.0.43-nightly.20260920.2031`. References 40–49 use Effect
`4.0.0-beta.103`, references 50–52 use `4.0.0-rc.112`, and references 53–54 use
`4.0.0-rc.115`.

## Compatibility findings

- The importer-facing event payloads and provider binding fields work across all
  fifteen references, so they use one shared writer. Additional project metadata
  in newer contracts is optional. T3 remains responsible for projection defaults
  and migration repairs; the importer does not write projection rows.
- Bootstrap processes projectors independently. A turn projector can see the
  session projector's final state while replaying older messages. Imported turns
  therefore emit their terminal session event before their assistant messages.
  This preserves interrupted/error turn states and terminal timestamps without
  inventing checkpoint events or leaving messages marked as streaming. Event IDs,
  original content timestamps, and the number of emitted events remain stable.
- Checkpoint recovery recognizes both the older settlement-last layout and the
  new layout. Newly written/recovered ledger entries record the actual database
  migration. Upgrading T3 does not rewrite existing ledger entries or event IDs.
- The migration-50 reference adds `projection.attachment-cleanup`, a bootstrap-only
  maintenance cursor. Backlog checks exclude that cursor but still require the
  read-model projectors to catch up. A database containing only the maintenance
  cursor is still considered unprojected when it has events.
- Migrations 51 and 52 add nullable message-context and title-state columns.
  Their event fields are optional, so existing imported events retain their
  meaning without adding synthetic context or title metadata. Migration 53 adds
  independent pull-request file-view tracking. The shared event writer and
  provider bindings pass the same checks on stable 0.0.42 and the pinned nightly.
- Migration 54 adds nullable `projection_threads.auto_settle_disabled_at`.
  Imported threads retain T3's default auto-settle behavior; the shared event
  writer and provider bindings are validated against stable v0.0.44.

## Reproduce validation

Use a checkout containing the pinned commits at `repos/t3code`, or set
`T3_REFERENCE_REPO` to another local checkout. Preparation uses `git archive` and
does not switch or edit that checkout. Git, tar, Node.js 22.21.1 or newer, and npm
are required. Dependency installation requires network access.

```text
npm run compat:prepare
npm run test:compatibility
```

The first command is optional because the second includes it. Dependencies and
source snapshots live under the gitignored `artifacts/compatibility` directory.
The harness pins Effect and its platform packages together, including transitive
platform-node-shared, to avoid mixing incompatible prereleases.

For a focused rerun after preparation:

```text
npx tsx scripts/compatibility/run.ts 54
```

Each full run executes 58 scenarios: both sources at all fifteen versions, plus
both sources upgrading from each version 40–53 to 54. Each scenario covers real
migration execution, event decoding, startup projection, custom instance binding,
idempotent import/sync/replace, ledger recovery, title updates, changed-history
conflicts, attachments, plans, activities, terminal states, replacement visibility,
resume dispatch, and adoption of a controlled continuation without duplicate events.

The real T3 ProviderService restores persisted cwd/resume state and routes it to
controlled adapters. Those doubles check the original provider cursor and receive
a subsequent turn on the imported/replacement task. Controlled continuation events
are then appended and projected through T3's real event store and projector.
This tests persistence and routing, not provider CLI execution, credentials, network
services, browser rendering, or the orchestration reactor's provider-event translation.

Results are written incrementally to a new
`artifacts/compatibility/run-*/results.json`; the command prints the final path.
A successful full run must report all 54 scenarios. A failed scenario stops the
command with a nonzero exit code; partial reports are not evidence of a full pass.

## Regenerate schema fixtures

```text
npm run compat:prepare
npm run compat:schemas
npm test
npm run typecheck
npm run build
```

Fixture generation runs each historical migration runner on a fresh, marked
synthetic T3 home and exports its complete DDL and migration records. Execution
timestamps are normalized to keep the committed JSON reproducible. Ordinary tests
use that JSON without downloading or importing the T3 reference repository.

Synthetic homes are retained under `artifacts/compatibility` for diagnosis. The
runner refuses homes without its fixture marker. It never snapshots or opens the
installed application's database, starts a live T3 application, or invokes paid
provider processes. Reference sources, integration dependencies, and synthetic
data are excluded from the published npm package.
