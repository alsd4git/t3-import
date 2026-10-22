import Database from "better-sqlite3";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectLinkedThreads } from "../src/target/reconciliation.js";
import { importConversations } from "../src/target/importer.js";
import { canonicalConversation, createTarget } from "./helpers.js";

const roots: string[] = [];
let originalLedgerDir: string | undefined;

beforeEach(() => { originalLedgerDir = process.env.T3_IMPORT_DATA_DIR; });
afterEach(async () => {
  if (originalLedgerDir === undefined) delete process.env.T3_IMPORT_DATA_DIR;
  else process.env.T3_IMPORT_DATA_DIR = originalLedgerDir;
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(migration: number) {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "t3-reconciliation-"));
  roots.push(root);
  process.env.T3_IMPORT_DATA_DIR = join(root, "ledger");
  const paths = createTarget(join(root, "t3"), migration);
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  return { root, paths, workspace };
}

describe("linked thread evidence report", () => {
  it.each([62, 67])("keeps V1 identity historical until a verified V2 handoff exists, migration %i", async (migration) => {
    const { paths, workspace } = await fixture(migration);
    const conversation = canonicalConversation(workspace);
    const imported = await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true });
    const threadId = imported.results[0]!.threadId;
    const db = new Database(paths.dbPath);
    try {
      db.prepare(`INSERT INTO provider_session_runtime
        (thread_id,provider_name,adapter_key,runtime_mode,status,last_seen_at,resume_cursor_json,runtime_payload_json,provider_instance_id)
        VALUES (?,'codex','codex','full-access','stopped',?,?,'{}','codex')`)
        .run(threadId, "2026-01-01T00:00:00.000Z", JSON.stringify({ threadId: "legacy-session" }));
      db.prepare(`UPDATE orchestration_v2_projection_threads SET active_provider_thread_id=NULL,
        payload_json=json_set(payload_json,'$.historyOrigin','v1_import','$.activeProviderThreadId',NULL) WHERE thread_id=?`).run(threadId);
      const provider = db.prepare("SELECT provider_thread_id id,payload_json payload FROM orchestration_v2_projection_provider_threads WHERE thread_id=?").get(threadId) as { id: string; payload: string };
      db.prepare("DELETE FROM orchestration_v2_projection_provider_threads WHERE thread_id=?").run(threadId);
      // Remove the synthetic import identity: this fixture now represents native V1 cutover.
      db.prepare("UPDATE orchestration_events SET metadata_json='{}' WHERE stream_id=?").run(threadId);
      const historical = await inspectLinkedThreads(paths, { source: "codex" });
      expect(historical.threads).toMatchObject([{
        threadId, mapping: "historical", bindings: [],
        historicalBindings: [{ nativeId: "legacy-session", strength: "strong" }],
        migration: { status: "legacy-only", handoffIds: [] },
      }]);
      expect((await inspectLinkedThreads(paths, { source: "opencode" })).threads).toHaveLength(0);

      const payload = JSON.parse(provider.payload);
      payload.nativeThreadRef.nativeId = "new-session";
      db.prepare(`INSERT INTO orchestration_v2_projection_provider_threads
        (provider_thread_id,thread_id,provider,status,updated_at,payload_json,driver,provider_instance_id)
        VALUES (?,?,'codex','idle',?,?, 'codex','codex')`).run(provider.id, threadId, "2026-01-02T00:00:00.000Z", JSON.stringify(payload));
      db.prepare(`UPDATE orchestration_v2_projection_threads SET active_provider_thread_id=?,
        payload_json=json_set(payload_json,'$.activeProviderThreadId',?) WHERE thread_id=?`).run(provider.id, provider.id, threadId);
      expect((await inspectLinkedThreads(paths)).threads[0]).toMatchObject({
        mapping: "strong", bindings: [{ nativeId: "new-session" }],
        historicalBindings: [{ nativeId: "legacy-session" }], migration: { status: "unverified" },
      });
      const handoff = { id: "cutover-handoff", threadId, toProviderThreadId: provider.id,
        strategy: "manual_context", status: "ready", coveredRunOrdinals: { from: 1, to: 1 } };
      db.prepare(`INSERT INTO orchestration_v2_projection_context_handoffs
        (context_handoff_id,thread_id,target_run_id,to_provider_thread_id,strategy,status,updated_at,payload_json)
        VALUES (?,?,?,?,'manual_context','ready',?,?)`).run(handoff.id, threadId, "run-1", provider.id, "2026-01-02T00:00:00.000Z", JSON.stringify(handoff));
      expect((await inspectLinkedThreads(paths)).threads[0]).toMatchObject({
        migration: { status: "continued", handoffIds: ["cutover-handoff"] },
      });
      db.prepare("UPDATE orchestration_v2_projection_context_handoffs SET payload_json=json_set(payload_json,'$.toProviderThreadId','unrelated')").run();
      expect((await inspectLinkedThreads(paths)).threads[0]?.migration?.status).toBe("unverified");
      db.prepare("UPDATE orchestration_v2_projection_threads SET deleted_at='deleted' WHERE thread_id=?").run(threadId);
      expect((await inspectLinkedThreads(paths)).threads).toHaveLength(0);
    } finally { db.close(); }
  });

  it("classifies and source-filters canonical history-only imports after collecting their identity", async () => {
    const { paths, workspace } = await fixture(67);
    const conversation = canonicalConversation(workspace);
    await importConversations([{ conversation, resume: false }], paths, { dryRun: false, resume: false });
    const db = new Database(paths.dbPath);
    try { db.prepare("DELETE FROM orchestration_v2_projection_provider_threads").run(); }
    finally { db.close(); }
    const report = await inspectLinkedThreads(paths, { source: "codex" });
    expect(report.threads).toMatchObject([{ mapping: "strong", origin: "imported", bindings: [{ nativeId: conversation.summary.id }] }]);
  });

  it.each([62, 67])("reports strong V2 provider binding and import origin for migration %i", async (migration) => {
    const { paths, workspace } = await fixture(migration);
    const conversation = canonicalConversation(workspace);
    const imported = await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true });
    const report = await inspectLinkedThreads(paths);
    expect(report).toMatchObject({ migration, provisional: false, transcriptEquality: "not_assessed" });
    expect(report.threads).toHaveLength(1);
    expect(report.threads[0]).toMatchObject({
      threadId: imported.results[0]!.threadId,
      title: conversation.threads[0]!.title,
      projectRoot: workspace,
      effectiveCwd: workspace,
      origin: "imported",
      mapping: "strong",
      bindings: [{ source: "codex", nativeId: conversation.threads[0]!.sourceSessionId, strength: "strong", providerInstanceId: "codex" }],
    });
    expect(report.threads[0]!.evidence.join(" ")).toContain("nativeThreadRef");
  });

  it("reports legacy V1 direct provider runtime bindings without claiming transcript equality", async () => {
    const { paths, workspace } = await fixture(54);
    const conversation = canonicalConversation(workspace);
    const imported = await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true });
    const report = await inspectLinkedThreads(paths);
    expect(report.threads).toHaveLength(1);
    expect(report.threads[0]).toMatchObject({
      threadId: imported.results[0]!.threadId,
      origin: "imported",
      mapping: "strong",
      bindings: [{ source: "codex", nativeId: conversation.threads[0]!.sourceSessionId, strength: "strong", status: "stopped" }],
    });
    expect(report.transcriptEquality).toBe("not_assessed");
  });

  it("includes provider subagents regardless of creation source and marks duplicate native links ambiguous", async () => {
    const { paths, workspace } = await fixture(67);
    const db = new Database(paths.dbPath);
    const timestamp = "2026-01-01T00:00:00.000Z";
    const projectId = "project";
    db.prepare(`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at)
      VALUES (?,?,?,'[]',?,?)`).run(projectId, "Workspace", workspace, timestamp, timestamp);
    const insertThread = db.prepare(`INSERT INTO orchestration_v2_projection_threads
      (thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,active_provider_thread_id,created_at,updated_at,archived_at,deleted_at,payload_json,provider_instance_id)
      VALUES (?,?,?,'codex','full-access','default',NULL,?,?,NULL,?,?, 'codex')`);
    const base = { createdBy: "system", creationSource: "server", projectId, title: "x", providerInstanceId: "codex", worktreePath: null, archivedAt: null, deletedAt: null };
    insertThread.run("parent", projectId, "Parent", timestamp, timestamp, null, JSON.stringify({ ...base, id: "parent", lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "parent" } }));
    insertThread.run("child", projectId, "Subagent", timestamp, timestamp, null, JSON.stringify({ ...base, id: "child", lineage: { parentThreadId: "parent", relationshipToParent: "subagent", rootThreadId: "parent" } }));
    insertThread.run("deleted", projectId, "Deleted", timestamp, timestamp, timestamp, JSON.stringify({ ...base, id: "deleted", deletedAt: timestamp, lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "deleted" } }));
    const insertProvider = db.prepare(`INSERT INTO orchestration_v2_projection_provider_threads
      (provider_thread_id,thread_id,provider,status,updated_at,payload_json,driver,provider_instance_id)
      VALUES (?,?,'codex','completed',?,?,'codex','codex')`);
    const providerPayload = (id: string, appThreadId: string) => JSON.stringify({ id, driver: "codex", providerInstanceId: "codex", appThreadId, status: "completed", nativeThreadRef: { driver: "codex", nativeId: "duplicate-session", strength: "strong" } });
    insertProvider.run("native-parent", "parent", timestamp, providerPayload("native-parent", "parent"));
    insertProvider.run("native-child", "child", timestamp, providerPayload("native-child", "child"));
    insertProvider.run("native-deleted", "deleted", timestamp, providerPayload("native-deleted", "deleted"));
    db.close();

    const defaults = await inspectLinkedThreads(paths);
    expect(defaults.threads.map((thread) => thread.threadId)).toEqual(["parent"]);
    const withSubagents = await inspectLinkedThreads(paths, { includeSubagents: true });
    expect(withSubagents.threads.map((thread) => thread.threadId).sort()).toEqual(["child", "parent"]);
    expect(withSubagents.threads.find((thread) => thread.threadId === "child")).toMatchObject({ subagent: true, mapping: "ambiguous", lineage: { parentThreadId: "parent", relationshipToParent: "subagent", rootThreadId: "parent" } });
    expect(withSubagents.threads.find((thread) => thread.threadId === "parent")?.origin).toBe("native");
    expect(withSubagents.threads.find((thread) => thread.threadId === "parent")?.ambiguity[0]).toContain("also appears");
    expect(withSubagents.threads.some((thread) => thread.threadId === "deleted")).toBe(false);
  });

  it("filters by source and includes archived threads only when requested", async () => {
    const { paths, workspace } = await fixture(62);
    const conversation = canonicalConversation(workspace);
    await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true });
    const db = new Database(paths.dbPath);
    try {
      db.prepare("UPDATE orchestration_v2_projection_threads SET archived_at=?").run("2026-01-02T00:00:00.000Z");
    } finally { db.close(); }
    expect((await inspectLinkedThreads(paths)).threads).toHaveLength(0);
    expect((await inspectLinkedThreads(paths, { source: "codex", includeArchived: true })).threads).toMatchObject([{ archived: true, origin: "imported" }]);
    expect((await inspectLinkedThreads(paths, { source: "opencode", includeArchived: true })).threads).toHaveLength(0);
    writeFileSync(paths.runtimeStatePath, JSON.stringify({ version: 1, pid: process.pid }));
    expect(await inspectLinkedThreads(paths, { includeArchived: true })).toMatchObject({ provisional: true, runtime: { live: true, pid: process.pid } });
  });
});
