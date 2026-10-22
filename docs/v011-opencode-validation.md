# T3 0.1.1 and OpenCode validation

Validated locally on 21 October 2026 with Node.js 24.19.0. Package version
`0.5.0-v2.1` is a local fork prerelease, not an upstream npm release.
Synchronization is provider-to-T3 only. No reverse transcript writer is included.

Subsequent checks on 22 October passed **719 tests**, typecheck, build and the
[independent package installation check](package-validation.md). The read-only
links report now separates retained V1 identities from current V2 bindings and
first-run migration handoffs. The chooser reports per-row reasons and next
actions. A [bounded live OpenCode continuation](continuation-validation-2026-10-22.md)
confirmed reuse of an existing native session, while exposing T3's title-copy
behavior on resume. These later checks do not broaden the historical claims
below into a manual UI test of a newly imported conversation.

## Implemented

- Separate official persistence runtimes for T3 0.1.0, migration 62, and 0.1.1,
  migration 67. Each retains its pinned Effect patch release. V2 schema checks
  use the corresponding full manifest and migration names, including the removal
  of obsolete V1 projections in 0.1.1. V1 migrations 40–54 remain supported.
- OpenCode 2.x discovery and canonical parsing from consistent read-only SQLite
  transactions. Root sessions are listed by default. Model/variant, native
  session and message-head references, attachments, retries, reasoning and tool
  activity are preserved. Final idle records establish terminal status. A gap
  before later settled history fails closed; an active trailing turn is ignored.
  System/synthetic controls remain in OpenCode and are reported as warnings.
- OpenCode import, incremental sync, native-thread adoption, linked sync across
  workspaces, ledger recovery and replacement on V2. Reconciliation checks exact
  native turn references, text, status and attachment descriptors before writing.
  Ambiguous bindings, changed cwd, unfinished work and native child threads remain
  protected. No historical provider effects are enqueued.
- Interactive destination choice in the existing Ink TUI, using the same
  project/cwd validation as CLI import. Review shows the original working folder
  and destination. Native scratch remains limited to eligible existing paths.
- Read-only `links` report with provider IDs, origin, cwd, lineage, archive state
  and ambiguity. Child threads are opt-in, including server-created children.
  Running T3 makes the report provisional. It explicitly leaves transcript
  equality unassessed. The personal normalizer consumes this evidence and keeps
  its approved-preview naming workflow; this command changes no names.

## Checks

All **713 tests across 16 files passed**, along with typecheck, build and diff
whitespace checks. The V2 suite runs both official runtimes and covers all three
sources, native continuation adoption, idempotency, rollback, resumed reference
transfer, title/cwd preservation and unfinished-work refusals. Source tests cover
OpenCode retry/error outcomes, multipart text, variant mapping, attachments,
unsupported versions, child exclusion and incomplete-history gaps. TUI tests
cover compatible destination choices and scratch eligibility. Report tests cover
V1/V2, canonical import identity, duplicate references and child/archive filters.
The production dependency audit reported zero advisories.

```text
npm test -- --reporter=dot
npm run typecheck
npm run build
git diff --check
npm pack --ignore-scripts --pack-destination artifacts/v011-package-test --json
npm audit --omit=dev --json
```

The extracted package successfully created a synthetic 0.1.1 database through
its bundled migrations, imported an OpenCode transcript and repeated sync. It
preserved the session ID, user-message head, provider/model selection and variant;
integrity was OK and no provider effects existed. Package testing reused the
checkout's installed dependencies through a symlink, rather than claiming a
clean installation on another machine.

## Real-data checks without live writes

A consistent SQLite backup of the active T3 0.1.1 database accepted a previously
unlinked local OpenCode conversation: one terminal turn, ten visible messages,
27 target events. A repeated import returned `already-imported`, sync and sync
inspection returned `up-to-date`, integrity and foreign-key checks passed,
the native reference matched, and no provider effects were added. The newly
imported provider thread remained `not_loaded`. Its ledger was isolated from the
real import ledger. No cache reset ran against the installed application.

The already-linked native OpenCode conversation also returned `up-to-date` from
a separate read-only live inspection. The live `links` command accepted migration
67 and identified top-level and child Codex bindings. Counts are time-dependent
and the live report was provisional because T3 was running.

## Boundaries

No live T3/OpenCode/Codex metadata or transcripts were changed. No provider CLI
or paid continuation was started. Actual continuation from the installed T3 UI
is still a separate manual check; persisted resume references and synthetic
native continuation tests do not establish that end-to-end interaction.
Legacy OpenCode 1.x is unsupported. Interrupted steering histories without clear
idle boundaries require an explicit incomplete snapshot rather than guessed
terminal turns. Remote attachment URLs are not fetched.

The historical integration matrix requiring a separate checkout of pinned V1
commits was not rerun; committed historical schemas remain covered by the full
suite. The normalizer integration changed instructions and added its report
reference; its metadata apply helpers and approval requirements were preserved.
Pre-existing uncommitted skill edits were left outside the new skill commit.
All commits remain local; no push, PR, merge, release or package publication was
performed for this implementation.
