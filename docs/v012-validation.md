# T3 0.1.2 and compressed Codex validation

Validated on 23 October 2026, with Node.js 24.19.0.

## Official reference

- [T3 v0.1.2 release](https://github.com/pingdotgg/t3code/releases/tag/v0.1.2),
  commit `044f07257c9684ae4543bd1e1ebf9c394e9e3830`.
- Source archive SHA-256:
  `cb82ecbe1d9fcd2200f89a7cff420e6313683baaab2d8bd6468a9c22ae48fb32`.
- Effect remains pinned to 4.0.5. No new runtime dependency was introduced.

Every executable migration under `apps/server/src/persistence/Migrations` is
identical to the pinned 0.1.1 source. The ceiling remains migration 67,
`WebhookDedupe`. Generating both official schemas confirms identical DDL,
column manifests and normalized migration history.

The 0.1.2 contract adds optional approval `reason`/`fullAccessOverride` fields,
optional shell stop-request/error-code fields and the `queued-run.start` command.
ProjectionStore reads the new shell fields from existing data. EventSink adds
in-memory run outcome metrics, without new tables. The migration 67 writer now
uses the official 0.1.2 runtime; the 0.1.1 runtime remains a test reference.

Reproduce the schema and integration checks:

```sh
node scripts/v2/build-runtime.mjs 0.1.2
npm run compat:v2-schema
npx vitest run test/v2.test.ts test/schema.test.ts test/runtimeActivity.test.ts
npm run package:check
```

## Compressed rollouts

The JSONL reader uses Node's streaming Zstandard decoder. Tests cover decoded
fingerprint equality, Unicode across chunks, CRLF, corrupt/truncated archives,
invalid JSON and early stream closure during header discovery. Adapter tests
verify discovery, loading and preference for a matching plain rollout. The
packed CLI check imports compressed history, then syncs a newer plain copy while
the older compressed copy remains present.

On SSH host `cilate`, read-only discovery now finds all 11 active Codex sessions.
The two sessions previously omitted were compressed:

| Session | Settled turns | Messages |
| --- | ---: | ---: |
| Cilate · Inventory progetti Git | 10 | 34 |
| Cilate · Pi-hole / DNS / Tailscale | 5 | 15 |

Both real-file previews succeed without warnings. No additional production
conversations were imported during this check, and the source files were not
extracted or changed.
