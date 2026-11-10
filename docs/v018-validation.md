# T3 0.1.8 validation

## Official reference

- [T3 v0.1.8](https://github.com/pingdotgg/t3code/releases/tag/v0.1.8),
  commit `bf469bb19669671d0df2efda74ed73867a7137c0`.
- Source archive SHA-256:
  `bf7a9187e7022bcfbef2b4962774ebd2feca6e1a0a62a3210307e598ef56eaed`.
- Effect 4.1.2 reuses `effect-v017`. The build dependencies pin
  `@effect/platform-node` 4.1.2 from the same upstream catalog, as required by the
  new source-control imports reachable from the persistence bundle. Its bundled
  dependencies and licenses are recorded in the generated third-party notices.

## Persistence and activity

Migration 80, `ScheduledTaskThreadMode`, adds a non-null `thread_mode` column to
`scheduled_tasks` with default `new_thread`. Existing tasks that already have a
`thread_id` are assigned `continue`. Previous migration source files are unchanged.
The importer supports the resulting schema; only T3 applies production upgrades.

The official EventSink, ProjectionStore and SQLite client have changed since
0.1.7 and are bundled from the new commit. Historical imports remain passive;
no server, provider session or provider/outbox worker is started. Older pinned
runtimes remain present and continue to be selected by their schema migration.

Tests upgrade a populated migration-79 fixture with the official runner, compare
all prior messages, events and schedule data, verify modes and the default for
new tasks, then exercise sync and repeated sync after upgrade. Separate cases
verify future, due and running tasks in both modes. The existing V2 import,
replacement, search, schema validation and live dry-run suites also cover 80.
Future migration 81 is refused without writes.

## Local validation

Validation uses isolated generated fixtures and an external test ledger. It
never upgrades or edits a live T3 database. Run:

```sh
npm run typecheck
npx tsc --noEmit --noUnusedLocals --noUnusedParameters
npm test
npm run package:check
```

The packed-artifact check creates a T3 0.1.8 fixture with the included runtime,
imports a compressed Codex transcript, syncs its next turn, and verifies that a
repeated sync is idempotent, with healthy SQLite/FTS state and no pending effects.
On 10 November 2026, typecheck, the unused-declaration check and 1002 tests
passed on macOS with Node 26.13.0; the Windows-only native probe was skipped.
The packed-artifact check passed with Node 26.13.0 and Node 24.19.0.
Windows, Linux and Node 22 verification remains the responsibility of the CI matrix.
