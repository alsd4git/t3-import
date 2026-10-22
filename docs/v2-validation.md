# T3 0.1.0 validation

Validated on 17 October 2026, Node.js 24.19.0, on branch
`feat/t3-v010-v2-support`, based on `f09cb9a`. The development package version
is `0.5.0-v2.0`; this is not a published upstream release.

## Implementation

- Select `statev2.sqlite` when present and refuse writes to the retained V1 copy.
- Validate migration 62 against the pinned 0.1.0 migration names and full column
  manifest. V1 migrations 40–54 retain their existing writer.
- Use the bundled official V2 event sink and projection stores for atomic
  import, sync, and replacement. No historical provider work is enqueued.
- Restore native provider references, including the separate Claude conversation
  head. Preserve execution cwd, project assignment, local titles, and replacement
  lineage.
- Recover migrated imports through retained V1 event identities; exclude T3's
  duplicate migration transcript events from comparisons. Compare native Codex
  continuations before adopting them, and append later external history after
  native run positions.
- Refuse unfinished runs, pending effects/background work, pending V1 hydration,
  ambiguous or rebound native identities, changed cwd, and unprojected events.
  Provider-managed native subagents remain outside writable reconciliation.

## Verification

The full test suite covers historical schema profiles and the new V2 integration
cases: **676 tests passed across 14 files**, with typecheck and build passing.
V2 tests execute the official sink and stores, real migrations and legacy
importer, on synthetic databases. They include failure-trigger rollback, dry-run
immutability, ledger recovery, idempotency, both source providers, continuation
adoption, timeline ordering, scratch cwd, title preservation, and safety refusals.
Completed turns have no synthetic warning item; failed and interrupted turns
retain their notices. Terminal metadata and ledger recovery remain covered.

Commands used:

```text
npm test -- --reporter=dot
npm run typecheck
npm run build
npm pack --pack-destination artifacts/v2-package-test --json
npm audit --omit=dev --json
```

The extracted npm package also passed a synthetic V2 import and repeated sync,
verifying the compiled code, version lookup, schema manifest, and vendored runtime
paths. Runtime regeneration verifies the pinned source archive digest and retains
upstream and bundled dependency license notices. Production dependencies and the
separately locked vendoring dependencies reported zero advisories. The repository's
existing development-tool advisories were not addressed by an unrelated upgrade.

## Local transcript check

A small ColorNote transcript was imported into an isolated copy of the real
V2 database: four turns, thirteen messages, no attachments, and the original
execution cwd. A repeated import was idempotent, sync was up to date, SQLite
integrity and foreign-key checks passed, and no provider effects were queued.
The user subsequently ran the live import and confirmed it was visible in T3.
This manual import preceded the change that hides normal completion notices;
that presentation change is covered by the integration suite above.

The local YI Home comparison found that all sixteen turns in the old checkpoint
still matched the source. The nine messages in its two later source turns were
already visible in T3. This requires checkpoint/identity reconciliation rather
than blindly appending those turns. No reconciliation was applied.

## Limits

Automated validation did not modify the live T3 database, Codex metadata, or
source rollout. No provider CLI was invoked and no paid provider turn was run.
Native resume references were
validated through persistence contracts and official source inspection, not by
continuing a live provider session. The user's live import confirmation does
not establish that provider continuation was tested.

The separate historical integration matrix was not rerun: the checkout containing
its pinned historical commits at `repos/t3code` was absent. The complete unit suite
still exercises its committed generated schemas for all supported V1 migrations.
The V1-to-V2 integration test seeds frozen V1 projections before running T3's real
cutover, so it does not claim to retest V1 projection replay.

No merge, release, or new remote pull request is part of this validation.
