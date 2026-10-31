# T3 0.1.6 validation

## Official reference

- [T3 v0.1.6](https://github.com/pingdotgg/t3code/releases/tag/v0.1.6),
  commit `2359643cffa6ba9ee84d6f2694b935de54a8013e`.
- Source archive SHA-256:
  `1c08098314b6356942b3c13312ecb313b07d13de39261b6023cd8ec6b7991f1e`.
- Effect remains 4.0.5. No dependency upgrades were needed for the bundled writer.

## Persistence

The new ceiling is migration 76. Migration 73 adds partial indexes for active
turn items. Migration 74 replaces FTS maintenance triggers so attachment-only
bootstrap prompts are omitted from search, including the Claude Ultrathink
prefix and supported whitespace. The transcript itself is preserved.
Existing indexed placeholders remain until an upstream search-index rebuild;
the importer does not rebuild a production index.

Migration 75 backfills `completion_delivery_state` from subagent JSON and indexes
it. The official projector preserves delivery state when later events omit it.
Migration 76 adds nullable `pinned_at` and `archived_at` to project projections.
Tests preserve both states across import into an existing project, title sync
and thread replacement. Destination selection policy remains unchanged.

Activity and per-thread write guards block terminal app-owned tasks with
explicit `pending` or `claimed` completion delivery. `acknowledged`, `delivered`
and `disposed` are settled delivery states. The optional metadata may be absent
on native or historical tasks; its absence does not block maintenance. Existing
active-run and remote-stop guards still apply independently.

Production writes use the pinned official EventSink, ProjectionStore and
ProjectStore. Schema generation runs migrations only on isolated fixtures.
The test matrix retains all seven official release runtimes and the earlier
supported V1 profiles. Intermediate migrations 73–75 and future 77 are refused.

## Verification

Validated on macOS on 31 October 2026. Typecheck and all 891 tests in 23 files
passed with Node.js 26.13.0. Installed package checks passed with Node.js
22.23.2, 24.19.0 and 26.13.0, including compressed Codex import, resumed plain
rollout sync, idempotency and FTS search assertions.

The regression coverage includes import/sync/replace, resumable bindings, dry-run
and rollback, optional FTS fallback and backup rowid preservation, attachment
placeholder insert/update behavior, populated 0.1.5-to-0.1.6 fixture migration,
project pin/archive preservation, explicit pending delivery and historical
native subagent handling. No live provider conversations or T3 database were
modified.

```sh
node scripts/v2/build-runtime.mjs 0.1.6
npm run compat:v2-schema
npm run typecheck
npm test
npm run package:check
```

The GitHub Actions matrix covers Windows, macOS and Ubuntu on Node.js 22, 24 and
26. Windows and Linux checks were not executed locally.
