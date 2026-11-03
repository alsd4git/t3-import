# Native title updates

T3 V2's `t3_thread_update` MCP tool can rename a thread while its server is
running. Use it for approved title-only changes. Import, transcript sync,
replacement and cache reset still require a closed or explicitly paused runtime.

Prepare a plan from a supported local database, including while T3 is open:

```sh
t3-import --json rename-plan --thread T3_THREAD_ID --title "Approved title" > title-plan.json
```

The ID is the T3 app thread ID from `links`, not a Codex/OpenCode session ID.
Archived threads require `--include-archived`; children require
`--include-subagents`. Deleted targets are excluded. An unchanged title returns
`status: unchanged` and no call. Empty titles and missing targets fail.

The command only reads a consistent snapshot and prints a plan. It never starts
or stops T3, contacts a server, modifies a title, opens an authentication session,
resets a cache, or writes an import checkpoint. The plan contains private thread
metadata; keep it with other local audit artifacts. Its `provisional` flag means
T3 was running at inspection time, so the preconditions must be checked again.

## Apply through an MCP-connected agent

The `codex-thread-normalizer` skill can consume this plan after its normal exact
preview approval. A CLI installation alone does not apply it: the agent needs
the selected environment's native T3 MCP tools.

1. Read the exact target with `t3_thread_read`. Confirm the environment, thread
   ID, current title, project, workspace, provider binding and lineage still match
   `expected`. Stop on changes and prepare a fresh preview. Read configured
   model/options separately when the naming plan includes a model badge.
2. After approval, back up the selected database using SQLite's consistent backup
   API, then invoke `call.tool` with `call.arguments`. Discover the installed tool
   schema first. Reuse the saved `clientRequestId` only when retrying this exact
   rename. For a remote environment, select its `environmentId` explicitly.
3. Verify the returned thread ID/title and sequence, then re-read the title and
   identity. Report partial success if a batch stops. Use native rename for an
   approved rollback; never restore over a live database.

The tool checks and mutation are separate requests, not an atomic compare-and-set.
Avoid concurrent title edits. A lost reply is not proof that the rename failed;
check the target before retrying with the same request ID. If native MCP is
unavailable, use T3's rename UI. Do not fall back to direct database updates.

This changes only the T3 display title. Codex/OpenCode title changes remain
separate operations with their own previews and authorization. A native rename
does not rewrite the importer's source-title baseline: later transcript sync
preserves a differing local title under its existing conflict policy.

## Native import is separate

The inspected T3 0.1.6 importer does not refresh the transcript of an existing
imported app thread. Its MCP thread send/transfer operations do not replace
external history reconciliation. `t3-import` therefore keeps its offline write
path; there is no direct database write mode for a live server.

References: [native MCP toolkits](https://github.com/pingdotgg/t3code/tree/cefb544af3c98224874419198c0359b652ca3c94/apps/server/src/mcp/toolkits),
[agent-session importer](https://github.com/pingdotgg/t3code/blob/cefb544af3c98224874419198c0359b652ca3c94/apps/server/src/project/AgentSessionImporter.ts).
