# T3 0.1.4 and 0.1.5 validation

Validated on 29 October 2026 with Node.js 24.19.0. The installed artifact
also passes on Node.js 22.23.2.

## Official references

- [T3 v0.1.4](https://github.com/pingdotgg/t3code/releases/tag/v0.1.4),
  commit `783581d461dc72cdd8f78fc8abb4ad536dfc4547`, source archive SHA-256
  `05fe610790f19eda92e6105f2b06c85062921ebb7c935b221bce20b92b17f4c0`.
- [T3 v0.1.5](https://github.com/pingdotgg/t3code/releases/tag/v0.1.5),
  commit `6d450a4284852af137b2f3407fddd89eb76e7644`, source archive SHA-256
  `2920ccdb457acd7c6f00ba95cd92fee3b58df1c6cc768ad2704ca34c1b378f93`.

Both releases use Effect 4.0.5 and migration 72. Generating their official schemas
produces identical DDL, column manifests and normalized migration history.
The 0.1.5 runtime writes migration 72; 0.1.4 is retained as a test reference.
The existing migration 62, 67 and 69 profiles retain their pinned runtimes.
The importer never migrates production databases. Intermediate migration 70/71
and future migration 73 are refused before writing.

## New persistence and activity

- 70 `PeerLinks` stores peer environment configuration and secret-store references.
- 71 `PeerLinkFence` adds the `fenced` column.
- 72 `WaitingLinkRequestIndex` adds a partial index on waiting link-request items.

Import, sync and replace preserve peer configuration. Thread metadata updates
preserve the optional `linkOrigin` and `delegatedFrom` fields. No source provider
transcripts or peer credentials are rewritten.

Waiting link-request cards count as unfinished work even after the run ends.
Remote tasks also remain unfinished while the peer still owes a result or a stop
request has not been delivered. A shared query matches the official
`ProjectionStore.getOpenRemoteDelegatedTasks` predicate. Global activity checks
prevent service pause, and per-thread guards prevent sync/replace from changing
an affected thread while allowing checks on unrelated threads.

## Checks

- Schema generation against all six pinned official releases, with identical
  schemas required for releases sharing a migration number.
- Typecheck passed; all 849 tests in 22 files passed.
- Import, sync, replacement, resumability, rollback, legacy migration and
  read-only dry runs against each pinned runtime.
- Message search with and without optional FTS5 at migrations 69 and 72;
  search updates/deletes and backup rowid preservation.
- Peer configuration and link-origin preservation, waiting-link refusal,
  remote result/stop states and thread-scoped guards.
- Installed package checks passed on Node.js 24.19.0 and 22.23.2. They use a
  synthetic 0.1.5 database, compressed Codex
  import, resumed plain-rollout sync, idempotency and FTS search assertions.

No live T3 database or production conversations were changed. Windows/Linux
validation remains in CI; it was not executed locally.

```sh
node scripts/v2/build-runtime.mjs 0.1.4
node scripts/v2/build-runtime.mjs 0.1.5
npm run compat:v2-schema
npm run typecheck
npm test
npm run package:check
```
