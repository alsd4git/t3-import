# T3 0.1.7 validation

## Official reference

- [T3 v0.1.7](https://github.com/pingdotgg/t3code/releases/tag/v0.1.7),
  commit `322f6544dfad0a3c8a0c8cbecf2c7f7874b14268`.
- Source archive SHA-256:
  `8879702bf005f491357acaaebe4b87599123033abad7b96909a1c3b75ee11f56`.
- Effect 4.1.2 is pinned as `effect-v017`. Earlier runtime aliases retain their
  existing versions. No provider, server or effect worker runs in the bundled
  persistence adapter.

## Persistence and activity

The supported ceiling is migration 79. Migration 77 repairs boolean thread
`settledOverride` values to `settled` or null. Migration 78 drops the unused
correlation index while preserving its column and event values. Migration 79
adds partial indexes for subagent result recovery and delegated delivery runs.
Schema columns remain compatible with the importer; production operations
never run database migrations. Intermediate migration 77 or 78 is refused.

The official EventSink, ProjectionStore and ProjectStore are bundled from the
tagged source. Tests upgrade populated migration-76 fixtures with the official
migration runner, preserve existing messages and events, verify the settlement
repair and index changes, then sync through the new runtime without losing the
repaired override. Repeated sync remains idempotent.

Activity inspection and per-thread write checks additionally recognize
`delegatedCompletion.delivery` objects on origin runs, matching T3's delegated
completion recovery candidates. A terminal run may still owe this delivery even
without a pending subagent projection. The importer refuses sync/replacement
and service maintenance until T3 finishes or disposes it; dry-runs mark that
target busy. This guard also applies when the optional metadata exists on older
supported V2 schemas.

One-time schedules need no new SQL path: persisted `enabled`, `next_run_at` and
`last_run_status` already distinguish future, due, running and finished tasks.
Tests cover all four cases with the actual `once` schedule shape. Missing or
malformed required state remains unknown rather than idle.

Kiro, managed policy configuration, share links and UI presentation changes do
not add an importer source or change destination policy. Existing native
provider identities and unrelated thread metadata remain preserved. Native
MCP title operations and the offline transcript-write requirement are unchanged.

## Verification

Validated on macOS on 4 November 2026. All 948 tests in 25 files passed with
Node.js 26.13.0, along with typechecking. The packed install check passed with
Node.js 22.23.2, 24.19.0 and 26.13.0 using migration 79, including compressed Codex import,
subsequent sync, idempotency, FTS, integrity, foreign keys and zero queued effects.
The package check now obtains its runtime and expected migration from the pinned
release profile instead of a separate hardcoded version.

Coverage retains all eight pinned T3 release runtimes and supported V1 schemas.
Windows/Linux checks remain assigned to CI and were not run locally. No live
T3 or provider database was migrated or written during this verification.

```sh
node scripts/v2/build-runtime.mjs 0.1.7
npm run compat:v2-schema
npm run typecheck
npm test
npm run package:check
```
