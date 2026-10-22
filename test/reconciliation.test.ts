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
