import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { canonicalConversation, canonicalThread, createTarget } from "./helpers.js";
import { importConversations } from "../src/target/importer.js";
import { syncConversations } from "../src/target/sync.js";
import { replaceConversations } from "../src/target/replace.js";
import { inspectRuntimeActivity } from "../src/target/runtimeActivity.js";
import { assertV2ThreadSettled } from "../src/target/v2.js";

let root: string;
let previousLedger: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t3-v016-"));
  previousLedger = process.env.T3_IMPORT_DATA_DIR;
  process.env.T3_IMPORT_DATA_DIR = join(root, "ledger");
});
afterEach(() => {
  if (previousLedger === undefined) delete process.env.T3_IMPORT_DATA_DIR;
  else process.env.T3_IMPORT_DATA_DIR = previousLedger;
  rmSync(root, { recursive: true, force: true });
});

const attachmentPrompt = "[User attached one or more files without additional text. Respond using the conversation context and the attached files.]";
it.each([attachmentPrompt, `Ultrathink:\n\u00a0${attachmentPrompt}`])("preserves attachment prompts but excludes them from search: %s", async (prompt) => {
  const paths = createTarget(root, 76);
  const conversation = canonicalConversation(root);
  conversation.threads[0]!.turns[0]!.user.text = prompt;
  conversation.threads[0]!.turns[0]!.assistant[0]!.text = "Actual searchable answer";
  await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true });
  const db = new Database(paths.dbPath);
  const matches = (term: string) => (db.prepare("SELECT COUNT(*) n FROM orchestration_v2_message_search WHERE orchestration_v2_message_search MATCH ?").get(term) as { n: number }).n;
  try {
    expect((db.prepare("SELECT json_extract(payload_json,'$.text') text FROM orchestration_v2_projection_messages WHERE role='user'").get() as { text: string }).text).toBe(prompt);
    expect(matches("attached")).toBe(0);
    expect(matches("answer")).toBe(1);
    db.prepare("UPDATE orchestration_v2_projection_messages SET payload_json=json_set(payload_json,'$.text','Real searchable question') WHERE role='user'").run();
    expect(matches("question")).toBe(1);
    db.prepare("UPDATE orchestration_v2_projection_messages SET payload_json=json_set(payload_json,'$.text',?) WHERE role='user'").run(prompt);
    expect(matches("question")).toBe(0);
    expect(matches("attached")).toBe(0);
  } finally { db.close(); }
});

it.each([
  { pinnedAt: "2026-01-02T00:00:00.000Z", archivedAt: null },
  { pinnedAt: null, archivedAt: "2026-01-02T00:00:00.000Z" },
])("preserves project pin/archive through import, sync and replacement: $pinnedAt / $archivedAt", async (state) => {
  const paths = createTarget(root, 76);
  const conversation = canonicalConversation(root);
  const first = await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true });
  const projectId = first.results[0]!.projectId!;
  const runtime = await import(new URL("../vendor/t3-v016/runtime.mjs", import.meta.url).href);
  await runtime.writeEvents(paths.dbPath, [{ aggregateKind: "project", projectEvent: {
    eventId: "project-pin-archive", type: "project.meta-updated", aggregateKind: "project", aggregateId: projectId,
    occurredAt: "2026-01-02T00:00:00.000Z", commandId: null, causationEventId: null, correlationId: null,
    payload: { projectId, ...state, updatedAt: "2026-01-02T00:00:00.000Z" }, metadata: {},
  } }]);
  const secondThread = canonicalThread(root);
  secondThread.sourceSessionId = "22222222-2222-4222-8222-222222222222";
  secondThread.sourceKey = `codex:${secondThread.sourceSessionId}`;
  secondThread.resumeCursor = { threadId: secondThread.sourceSessionId };
  const second = await importConversations([{ conversation: canonicalConversation(root, secondThread), resume: true }], paths, { dryRun: false, resume: true });
  expect(second.results[0]!.projectId).toBe(projectId);
  conversation.threads[0]!.title = "Updated thread title";
  await syncConversations([{ conversation }], paths, { dryRun: false });
  await replaceConversations([{ conversation }], paths, { dryRun: false });
  const db = new Database(paths.dbPath, { readonly: true });
  try {
    expect(db.prepare("SELECT pinned_at pinnedAt, archived_at archivedAt FROM projection_projects WHERE project_id=?").get(projectId)).toEqual(state);
    expect(db.prepare("SELECT COUNT(*) n FROM projection_projects").get()).toEqual({ n: 1 });
  } finally { db.close(); }
});

it.each([
  { state: "pending", busy: true },
  { state: "claimed", busy: true },
  { state: "acknowledged", busy: false },
  { state: "delivered", busy: false },
  { state: "disposed", busy: false },
  { state: undefined, busy: false },
])("checks explicit subagent delivery without blocking historical records: $state", async ({ state, busy }) => {
  const paths = createTarget(root, 76);
  const conversation = canonicalConversation(root);
  const imported = await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true });
  const threadId = imported.results[0]!.threadId!;
  const runtime = await import(new URL("../vendor/t3-v016/runtime.mjs", import.meta.url).href);
  const payload = {
    id: "task", threadId, runId: null, parentNodeId: "parent", origin: "app_owned",
    createdBy: "agent", driver: "codex", providerInstanceId: "codex",
    providerThreadId: null, childThreadId: "child", nativeTaskRef: null,
    prompt: "Task", title: "Task", model: null, status: "completed", result: "Done",
    startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:03.000Z",
    updatedAt: "2026-01-01T00:00:03.000Z",
    ...(state === undefined ? {} : { completionDelivery: { state, observedByRunId: null } }),
  };
  await runtime.writeEvents(paths.dbPath, [{ id: "delivery-event", threadId, type: "subagent.updated", occurredAt: payload.updatedAt, payload }]);
  // A later update may omit delivery metadata; the official projector must preserve it.
  const { completionDelivery: omitted, ...withoutDelivery } = payload;
  await runtime.writeEvents(paths.dbPath, [{ id: "delivery-omitted", threadId, type: "subagent.updated", occurredAt: payload.updatedAt, payload: withoutDelivery }]);
  const db = new Database(paths.dbPath, { readonly: true });
  try {
    expect(db.prepare("SELECT completion_delivery_state state FROM orchestration_v2_projection_subagents WHERE subagent_id='task'").get()).toEqual({ state: state ?? null });
    expect(inspectRuntimeActivity(paths)).toMatchObject({ status: busy ? "busy" : "idle", counts: { v2_pending_subagent_deliveries: busy ? 1 : 0 } });
    if (busy) expect(() => assertV2ThreadSettled(db, threadId)).toThrow("unfinished work");
    else expect(() => assertV2ThreadSettled(db, threadId)).not.toThrow();
    expect(() => assertV2ThreadSettled(db, "unrelated")).not.toThrow();
  } finally { db.close(); }
  if (busy) {
    await expect(syncConversations([{ conversation }], paths, { dryRun: false })).rejects.toMatchObject({ exitCode: 4 });
    await expect(replaceConversations([{ conversation }], paths, { dryRun: false })).rejects.toMatchObject({ exitCode: 4 });
  }
});

it("backfills delivery state and adds nullable project flags when upgrading a populated 0.1.5 fixture", async () => {
  const paths = createTarget(root, 72);
  const conversation = canonicalConversation(root);
  await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true });
  const db = new Database(paths.dbPath);
  db.prepare(`INSERT INTO orchestration_v2_projection_subagents
    (subagent_id,thread_id,parent_node_id,provider,origin,status,updated_at,payload_json)
    VALUES ('legacy-task','thread','node','codex','app_owned','completed','2026-01-01',?)`)
    .run(JSON.stringify({ completionDelivery: { state: "claimed", observedByRunId: null } }));
  db.close();
  const runtime = await import(new URL("../vendor/t3-v016/runtime.mjs", import.meta.url).href);
  await runtime.createSchema(paths.dbPath);
  const upgraded = new Database(paths.dbPath, { readonly: true });
  try {
    expect(upgraded.prepare("SELECT MAX(migration_id) migration FROM effect_sql_migrations").get()).toEqual({ migration: 76 });
    expect(upgraded.prepare("SELECT completion_delivery_state state FROM orchestration_v2_projection_subagents WHERE subagent_id='legacy-task'").get()).toEqual({ state: "claimed" });
    expect(upgraded.prepare("SELECT pinned_at, archived_at FROM projection_projects").all()).toEqual([{ pinned_at: null, archived_at: null }]);
    expect(upgraded.pragma("integrity_check", { simple: true })).toBe("ok");
  } finally { upgraded.close(); }
});

it("keeps historical native subagents without completion-delivery metadata idle", () => {
  const paths = createTarget(root, 76);
  const db = new Database(paths.dbPath);
  try {
    db.prepare(`INSERT INTO orchestration_v2_projection_subagents
      (subagent_id,thread_id,parent_node_id,provider,origin,status,updated_at,payload_json)
      VALUES ('native-history','thread','node','codex','provider_native','completed','2026-01-01','{}')`).run();
    expect(inspectRuntimeActivity(paths).status).toBe("idle");
    expect(() => assertV2ThreadSettled(db, "thread")).not.toThrow();
  } finally { db.close(); }
});
