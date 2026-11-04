import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { canonicalConversation, createTarget, eventCount } from "./helpers.js";
import { importConversations } from "../src/target/importer.js";
import { inspectConversationSync, syncConversations } from "../src/target/sync.js";
import { replaceConversations } from "../src/target/replace.js";
import { inspectRuntimeActivity } from "../src/target/runtimeActivity.js";
import { assertV2ThreadSettled } from "../src/target/v2.js";

let root: string;
let previousLedger: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t3-v017-"));
  previousLedger = process.env.T3_IMPORT_DATA_DIR;
  process.env.T3_IMPORT_DATA_DIR = join(root, "ledger");
});
afterEach(() => {
  if (previousLedger === undefined) delete process.env.T3_IMPORT_DATA_DIR;
  else process.env.T3_IMPORT_DATA_DIR = previousLedger;
  rmSync(root, { recursive: true, force: true });
});

async function runtime() {
  return import(new URL("../vendor/t3-v017/runtime.mjs", import.meta.url).href);
}

it.each([true, false])("upgrades a populated 0.1.6 fixture and repairs boolean settledOverride=%s", async (settled) => {
  const paths = createTarget(root, 76);
  const conversation = canonicalConversation(root);
  const result = await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true });
  const threadId = result.results[0]!.threadId;
  const before = new Database(paths.dbPath);
  before.prepare("UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.settledOverride',json(?)) WHERE thread_id=?").run(JSON.stringify(settled), threadId);
  const messages = before.prepare("SELECT * FROM orchestration_v2_projection_messages ORDER BY message_id").all();
  const events = before.prepare("SELECT * FROM orchestration_events ORDER BY sequence").all();
  before.close();
  const pinned = await runtime();
  await pinned.createSchema(paths.dbPath);
  const upgraded = new Database(paths.dbPath, { readonly: true });
  try {
    expect(upgraded.prepare("SELECT MAX(migration_id) migration FROM effect_sql_migrations").get()).toEqual({ migration: 79 });
    expect(upgraded.prepare("SELECT json_extract(payload_json,'$.settledOverride') value FROM orchestration_v2_projection_threads WHERE thread_id=?").get(threadId)).toEqual({ value: settled ? "settled" : null });
    expect(upgraded.prepare("SELECT * FROM orchestration_v2_projection_messages ORDER BY message_id").all()).toEqual(messages);
    expect(upgraded.prepare("SELECT * FROM orchestration_events ORDER BY sequence").all()).toEqual(events);
    const indexes = upgraded.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((row) => (row as { name: string }).name);
    expect(indexes).not.toContain("idx_orch_events_correlation_id");
    expect(indexes).toContain("orchestration_v2_projection_threads_subagent_result_idx");
    expect(indexes).toContain("orchestration_v2_projection_runs_delegated_delivery_idx");
    expect(upgraded.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(upgraded.pragma("foreign_key_check")).toEqual([]);
  } finally { upgraded.close(); }
  conversation.threads[0]!.title = "Updated after migration";
  expect((await syncConversations([{ conversation }], paths, { dryRun: false })).results[0]).toMatchObject({ status: "synced", titleAction: "updated" });
  const synced = new Database(paths.dbPath, { readonly: true });
  try {
    expect(synced.prepare("SELECT json_extract(payload_json,'$.settledOverride') value FROM orchestration_v2_projection_threads WHERE thread_id=?").get(threadId)).toEqual({ value: settled ? "settled" : null });
  } finally { synced.close(); }
  expect((await syncConversations([{ conversation }], paths, { dryRun: false })).status).toBe("up-to-date");
});

it("protects terminal origin runs with an outstanding delegated completion cohort", async () => {
  const paths = createTarget(root, 79);
  const conversation = canonicalConversation(root);
  const imported = await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true });
  const threadId = imported.results[0]!.threadId!;
  const pinned = await runtime();
  const timestamp = conversation.threads[0]!.updatedAt;
  const payload = {
    id: "origin-run", threadId, ordinal: 1, providerInstanceId: "codex", modelSelection: { instanceId: "codex", model: "gpt-test" },
    providerThreadId: null, userMessageId: "origin-user", rootNodeId: null, activeAttemptId: null, status: "completed",
    requestedAt: timestamp, startedAt: timestamp, completedAt: timestamp, checkpointId: null, contextHandoffId: null,
    delegatedCompletion: { disposition: "open", nextGeneration: 2, delivery: { generation: 1, messageId: "pending-delivery", taskIds: ["task"] } },
  };
  await pinned.writeEvents(paths.dbPath, [{ id: "origin-created", type: "run.created", threadId, occurredAt: timestamp, payload }]);
  const count = eventCount(paths.dbPath);
  expect(inspectRuntimeActivity(paths)).toMatchObject({ status: "busy", counts: { v2_pending_delegated_run_deliveries: 1, v2_pending_subagent_deliveries: 0 } });
  const db = new Database(paths.dbPath, { readonly: true });
  try {
    expect(() => assertV2ThreadSettled(db, threadId)).toThrow("unfinished work");
    expect(() => assertV2ThreadSettled(db, "unrelated")).not.toThrow();
  } finally { db.close(); }
  expect(await inspectConversationSync(conversation, paths)).toMatchObject({ status: "target-busy", selectable: false });
  await expect(syncConversations([{ conversation }], paths, { dryRun: false })).rejects.toMatchObject({ exitCode: 4 });
  await expect(replaceConversations([{ conversation }], paths, { dryRun: false })).rejects.toMatchObject({ exitCode: 4 });
  expect(eventCount(paths.dbPath)).toBe(count);
  await pinned.writeEvents(paths.dbPath, [{ id: "delivery-cleared", type: "run.updated", threadId, occurredAt: timestamp,
    payload: { ...payload, delegatedCompletion: { ...payload.delegatedCompletion, disposition: "disposed", delivery: null } } }]);
  expect(inspectRuntimeActivity(paths)).toMatchObject({ status: "idle", counts: { v2_pending_delegated_run_deliveries: 0 } });
});

it.each([
  { enabled: 1, next: "2999-01-01T00:00:00.000Z", last: "never", status: "idle", future: 1, due: 0, running: 0 },
  { enabled: 1, next: "2000-01-01T00:00:00.000Z", last: "never", status: "busy", future: 0, due: 1, running: 0 },
  { enabled: 1, next: "2000-01-01T00:00:00.000Z", last: "running", status: "busy", future: 0, due: 0, running: 1 },
  { enabled: 0, next: null, last: "succeeded", status: "idle", future: 0, due: 0, running: 0 },
])("recognizes one-time schedules: $last / $status / $next", (state) => {
  const paths = createTarget(root, 79);
  const db = new Database(paths.dbPath);
  const timestamp = "2026-01-01T00:00:00.000Z";
  try {
    db.prepare("INSERT INTO scheduled_tasks (task_id,title,prompt,enabled,schedule_json,project_id,workspace_strategy_json,model_selection_json,runtime_mode,interaction_mode,created_by,creation_source,created_at,updated_at,next_run_at,last_run_status,run_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("once", "One-time task", "prompt", state.enabled, JSON.stringify({ type: "once", runAt: state.next ?? timestamp }), "project", "{}", "{}", "full-access", "default", "user", "mcp", timestamp, timestamp, state.next, state.last, 0);
  } finally { db.close(); }
  expect(inspectRuntimeActivity(paths)).toMatchObject({ status: state.status, counts: { scheduler_future_tasks: state.future, scheduler_due_tasks: state.due, scheduler_running_tasks: state.running } });
});
