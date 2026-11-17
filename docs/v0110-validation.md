# T3 0.1.9 and 0.1.10 validation

The bundled runtimes use official source archives with SHA-256 checks recorded
in each vendor reference.json. Supported schemas are 81 and 96; intermediate
schemas remain refused. Effect 4.1.3 is isolated under effect-v0110.

Validation uses synthetic databases only. Tests upgrade populated schema 80
through the official migration runners to both supported targets, preserving
message payloads and events. They verify readable citation text and comments,
FTS matches, exact turn-item counts, custom project title state, sync and repeated
sync. Existing import/sync/replace, optional FTS, runtime activity and live dry-run
suites cover both new profiles. Earlier profiles remain covered.

Local checks: typecheck, full Vitest suite, focused upgrade tests, and package:check.
The package check packs and installs the artifact and imports/syncs using schema 96.
Windows native desktop tests require Windows and are skipped on macOS. The
cross-platform CI matrix has not been run for these local changes.

No live conversation, authentication data, or T3 database was modified.
The importer does not upgrade databases or provide a migration rollback; T3 owns
those operations and its backups.
