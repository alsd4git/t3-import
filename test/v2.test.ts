import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { canonicalConversation, createTarget, eventCount } from "./helpers.js";
import { importConversations } from "../src/target/importer.js";
import { inspectConversationSync, syncConversations } from "../src/target/sync.js";
import { resolveTargetPaths } from "../src/target/config.js";
import { replaceConversations } from "../src/target/replace.js";
import { syncAllLinkedConversations } from "../src/target/syncAll.js";
import type { CanonicalConversation, SourceName } from "../src/core/types.js";

describe.each([
  { migration: 62, release: "0.1.0", directory: "t3-v010" },
  { migration: 67, release: "0.1.1", directory: "t3-v011" },
  { migration: 67, release: "0.1.2", directory: "t3-v012" },
  { migration: 69, release: "0.1.3", directory: "t3-v013" },
  { migration: 72, release: "0.1.4", directory: "t3-v014" },
  { migration: 72, release: "0.1.5", directory: "t3-v015" },
])("T3 $release / V2 migration $migration", ({ migration, directory }) => {
let root: string;
let ledger: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t3-v2-"));
  ledger = process.env.T3_IMPORT_DATA_DIR;
  process.env.T3_IMPORT_DATA_DIR = join(root, "ledger");
});
afterEach(() => {
  if (ledger === undefined) delete process.env.T3_IMPORT_DATA_DIR;
  else process.env.T3_IMPORT_DATA_DIR = ledger;
  rmSync(root, { recursive: true, force: true });
});

it("prefers V2 and projects a resumable import through the official sink", async () => {
  const paths = createTarget(root, migration);
  expect(resolveTargetPaths({ t3Home: root }).dbPath).toBe(paths.dbPath);
  const conversation = canonicalConversation(root);
  const result = await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true });
  expect(result.status).toBe("imported");
  const db = new Database(paths.dbPath, { readonly: true });
  try {
    expect(db.prepare("SELECT json_extract(payload_json,'$.text') text FROM orchestration_v2_projection_messages ORDER BY created_at").all()).toEqual([{ text: "Hello" }, { text: "Hi" }]);
    expect(db.prepare("SELECT status FROM orchestration_v2_projection_provider_threads").all()).toEqual([{ status: "not_loaded" }]);
    expect(db.prepare("SELECT * FROM provider_session_runtime").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM orchestration_v2_effect_outbox").all()).toEqual([]);
    expect(db.prepare("SELECT type FROM orchestration_v2_projection_turn_items ORDER BY ordinal").all()).toEqual([
      { type: "user_message" }, { type: "command_execution" }, { type: "assistant_message" },
    ]);
    expect(db.prepare("SELECT COUNT(*) n FROM orchestration_events WHERE json_extract(metadata_json,'$.t3ImportTerminalStatus')='completed'").get()).toEqual({ n: 1 });
  } finally { db.close(); }
  const count = eventCount(paths.dbPath);
  expect(result.results[0]!.events).toBe(count);
  expect(result.results[0]!.sequence!.last).toBe(count);
  expect((await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true })).status).toBe("already-imported");
  expect((await syncConversations([{ conversation }], paths, { dryRun: false })).status).toBe("up-to-date");
  expect(eventCount(paths.dbPath)).toBe(count);
});

it.each(["failed", "interrupted"] as const)("keeps %s imported turns visible as notices", async (status) => {
  const paths = createTarget(root, migration);
  const conversation = canonicalConversation(root);
  conversation.threads[0]!.turns[0]!.status = status;
  if (status === "failed") conversation.threads[0]!.turns[0]!.terminalError = "Provider failed";
  await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true });
  const db = new Database(paths.dbPath, { readonly: true });
  try {
    const rows = db.prepare("SELECT payload_json payload FROM orchestration_v2_projection_turn_items WHERE type='system_notice'").all() as Array<{ payload: string }>;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.payload)).toMatchObject({
      status, message: status === "failed" ? "Imported turn failed: Provider failed" : "Imported turn interrupted.",
    });
  } finally { db.close(); }
  expect((await inspectConversationSync(conversation, paths)).status).toBe("up-to-date");
});

it("rolls back official event/projection writes and removes staged attachments on failure", async () => {
  const paths = createTarget(root, migration);
  const conversation = canonicalConversation(root);
  conversation.threads[0]!.turns[0]!.user.attachments.push({ sourceId: "image", name: "image.png", mimeType: "image/png", sizeBytes: 3, data: Buffer.from("png") });
  const db = new Database(paths.dbPath);
  db.exec("CREATE TRIGGER reject_message BEFORE INSERT ON orchestration_v2_projection_messages BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  db.close();
  await expect(importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true })).rejects.toMatchObject({ exitCode: 6 });
  expect(eventCount(paths.dbPath)).toBe(0);
  expect(existsSync(join(root, "ledger"))).toBe(false);
  const after = new Database(paths.dbPath, { readonly: true });
  try {
    expect(after.prepare("SELECT * FROM projection_projects").all()).toEqual([]);
    expect(after.prepare("SELECT * FROM orchestration_v2_projection_threads").all()).toEqual([]);
  } finally { after.close(); }
});

function addTurn(conversation: CanonicalConversation): void {
  const thread = conversation.threads[0]!;
  const turn = structuredClone(thread.turns[0]!);
  const index = thread.turns.length + 1;
  turn.id = `turn-${index}`;
  turn.startedAt = `2026-01-0${index}T00:00:00.000Z`;
  turn.completedAt = `2026-01-0${index}T00:00:03.000Z`;
  turn.user = { ...turn.user, sourceId: `user-${index}`, text: `Question ${index}`, timestamp: turn.startedAt };
  turn.assistant = [{ ...turn.assistant[0]!, sourceId: `assistant-${index}`, text: `Answer ${index}`, timestamp: turn.completedAt }];
  turn.activities = [];
  thread.turns.push(turn);
  thread.updatedAt = turn.completedAt;
  conversation.fingerprint = `fingerprint-${index}`;
}

it.each(["codex", "claude", "opencode"] as SourceName[])("syncs and replaces %s with ledger recovery and stable cwd", async (source) => {
  const paths = createTarget(root, migration);
  const conversation = canonicalConversation(root);
  const thread = conversation.threads[0]!;
  if (source === "claude") {
    thread.source = source;
    thread.sourceKey = `claude:${thread.sourceSessionId}:leaf-1`;
    thread.resumeCursor = { resume: thread.sourceSessionId, resumeSessionAt: "leaf-1" };
    thread.leafId = "leaf-1";
    conversation.summary.source = source;
  }
  if (source === "opencode") {
    thread.source = source;
    thread.sourceKey = `opencode:${thread.sourceSessionId}`;
    thread.resumeCursor = { sessionId: thread.sourceSessionId, headMessageId: thread.turns[0]!.id };
    thread.modelOptions = [{ id: "variant", value: "high" }];
    conversation.summary.source = source;
  }
  const first = await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true });
  process.env.T3_IMPORT_DATA_DIR = join(root, "recovered-ledger");
  addTurn(conversation);
  if (source === "claude") thread.resumeCursor = { resume: thread.sourceSessionId, resumeSessionAt: "leaf-2" };
  if (source === "opencode") thread.resumeCursor = { sessionId: thread.sourceSessionId, headMessageId: thread.turns.at(-1)!.id };
  const sync = await syncConversations([{ conversation }], paths, { dryRun: false });
  expect(sync.results[0]).toMatchObject({ turnsAdded: 1, threadId: first.results[0]!.threadId });
  expect(sync.status).toBe("synced");
  expect((await syncConversations([{ conversation }], paths, { dryRun: false })).status).toBe("up-to-date");
  if (source === "opencode") {
    const all = await syncAllLinkedConversations({ name: source, discover: async () => [conversation.summary], load: async () => conversation }, paths, { dryRun: false });
    expect(all.status).toBe("up-to-date");
    expect(all.results).toHaveLength(1);
  }
  const replacement = await replaceConversations([{ conversation }], paths, { dryRun: false });
  expect(replacement.status).toBe("replaced");
  expect(replacement.results[0]!.resumeTransferred).toBe(true);
  expect((await replaceConversations([{ conversation }], paths, { dryRun: false })).status).toBe("already-current");
  const db = new Database(paths.dbPath, { readonly: true });
  try {
    const old = db.prepare("SELECT deleted_at value FROM orchestration_v2_projection_threads WHERE thread_id=?").get(first.results[0]!.threadId) as { value: string };
    expect(old.value).toBeTruthy();
    const provider = db.prepare("SELECT payload_json payload FROM orchestration_v2_projection_provider_threads WHERE thread_id=?").get(replacement.results[0]!.newThreadId) as { payload: string };
    const payload = JSON.parse(provider.payload);
    expect(payload.nativeThreadRef.nativeId).toBe(thread.sourceSessionId);
    if (source === "claude") expect(payload.nativeConversationHeadRef.nativeId).toBe("leaf-2");
    if (source === "opencode") expect(payload.nativeConversationHeadRef.nativeId).toBe(thread.turns.at(-1)!.id);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(db.pragma("foreign_key_check")).toEqual([]);
  } finally { db.close(); }
});

it("keeps a V2 dry run read-only, including a missing ledger", async () => {
  const paths = createTarget(root, migration);
  const before = readFileSync(paths.dbPath);
  const result = await importConversations([{ conversation: canonicalConversation(root), resume: true }], paths, { dryRun: true, resume: true });
  expect(result.status).toBe("dry-run");
  expect(readFileSync(paths.dbPath)).toEqual(before);
  expect(existsSync(join(root, "ledger"))).toBe(false);
  expect(existsSync(paths.attachmentsDir)).toBe(false);
});

it("refuses an unprojected V2 event backlog without creating a backup or ledger", async () => {
  const paths = createTarget(root, migration);
  const db = new Database(paths.dbPath);
  db.prepare("INSERT INTO orchestration_events (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json,application_event_version) VALUES ('orphan','thread','unprojected',0,'thread.created','2026-01-01T00:00:00.000Z','server','{}','{}',2)").run();
  db.close();
  await expect(importConversations([{ conversation: canonicalConversation(root), resume: true }], paths, { dryRun: false, resume: true })).rejects.toMatchObject({ exitCode: 4, message: expect.stringContaining("unprojected") });
  expect(eventCount(paths.dbPath)).toBe(1);
  expect(existsSync(join(root, "ledger"))).toBe(false);
  expect(existsSync(join(paths.stateDir, "t3-import-backups"))).toBe(false);
});

async function officialRuntime(): Promise<any> {
  return import(new URL(`../vendor/${directory}/runtime.mjs`, import.meta.url).href);
}

it.each(["codex", "opencode"] as const)("adopts exact native V2 %s turns and rejects a changed transcript", async (source) => {
  const paths = createTarget(root, migration);
  const conversation = canonicalConversation(root);
  if (source === "opencode") {
    const thread = conversation.threads[0]!;
    thread.source = source;
    thread.sourceKey = `opencode:${thread.sourceSessionId}`;
    thread.resumeCursor = { sessionId: thread.sourceSessionId };
    conversation.summary.source = source;
  }
  const result = await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true });
  const threadId = result.results[0]!.threadId!;
  const db = new Database(paths.dbPath);
  const provider = JSON.parse((db.prepare("SELECT payload_json payload FROM orchestration_v2_projection_provider_threads").get() as { payload: string }).payload);
  const items = (db.prepare("SELECT payload_json payload FROM orchestration_v2_projection_turn_items WHERE type IN ('user_message','assistant_message')").all() as Array<{ payload: string }>).map((row) => JSON.parse(row.payload));
  // Model an existing native T3 thread, with no importer identity/checkpoint.
  db.prepare("UPDATE orchestration_events SET event_id='native-created', metadata_json='{}' WHERE event_type='thread.created'").run();
  db.prepare("UPDATE orchestration_events SET metadata_json='{}'").run();
  db.close();
  process.env.T3_IMPORT_DATA_DIR = join(root, "no-ledger");
  const runtime = await officialRuntime();
  await runtime.writeEvents(paths.dbPath, [
    ...items.map((item, index) => ({ id: `native-item-${index}`, threadId, type: "turn-item.updated", occurredAt: item.updatedAt,
      payload: { ...item, providerThreadId: provider.id, providerTurnId: "v2-turn-1" } })),
    { id: "native-terminal", threadId, type: "provider-turn.updated", occurredAt: conversation.threads[0]!.updatedAt,
      payload: { id: "v2-turn-1", providerThreadId: provider.id, nodeId: "native-node", runAttemptId: null,
        nativeTurnRef: { driver: source, nativeId: "turn-1", strength: source === "codex" ? "strong" : "weak" }, ordinal: 1, status: "completed",
        startedAt: conversation.threads[0]!.createdAt, completedAt: conversation.threads[0]!.updatedAt } },
  ]);
  addTurn(conversation);
  expect(await inspectConversationSync(conversation, paths)).toMatchObject({ status: "syncable", newTurns: 1, threadId });
  const changed = structuredClone(conversation);
  changed.threads[0]!.turns[0]!.assistant[0]!.text = "Changed answer";
  const before = eventCount(paths.dbPath);
  expect((await syncConversations([{ conversation: changed }], paths, { dryRun: false })).results[0]!.status).toBe("history-diverged");
  expect(eventCount(paths.dbPath)).toBe(before);
  expect((await syncConversations([{ conversation }], paths, { dryRun: false })).results[0]).toMatchObject({ turnsAdded: 1 });
  expect((await syncConversations([{ conversation }], paths, { dryRun: false })).status).toBe("up-to-date");
});

it("migrates an existing V1 import without reimporting its transcript", async () => {
  const paths = createTarget(root, 54);
  const conversation = canonicalConversation(root);
  const thread = conversation.threads[0]!;
  const result = await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true });
  const { threadId, projectId } = result.results[0]!;
  const db = new Database(paths.dbPath);
  // Frozen projections are the input to T3's own V1 cutover. The V1 event
  // writer is covered by its historical suites; these rows model app startup.
  db.prepare("INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (?,?,?,'[]',?,?)").run(projectId, thread.title, root, thread.createdAt, thread.updatedAt);
  db.prepare("INSERT INTO projection_threads (thread_id,project_id,title,model_selection_json,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(threadId, projectId, thread.title, JSON.stringify({ instanceId: "codex", model: "gpt-test" }), thread.createdAt, thread.updatedAt);
  const rows = db.prepare("SELECT payload_json payload FROM orchestration_events WHERE event_type='thread.message-sent'").all() as Array<{ payload: string }>;
  for (const row of rows) {
    const message = JSON.parse(row.payload);
    db.prepare("INSERT INTO projection_thread_messages (message_id,thread_id,role,text,is_streaming,created_at,updated_at,attachments_json) VALUES (?,?,?,?,0,?,?,?)").run(message.messageId, threadId, message.role, message.text, message.createdAt, message.updatedAt, JSON.stringify(message.attachments ?? []));
  }
  const v2Path = join(paths.stateDir, "statev2.sqlite");
  await db.backup(v2Path);
  db.close();
  const runtime = await officialRuntime();
  await runtime.createSchema(v2Path);
  await runtime.importLegacy(v2Path);
  const v2Paths = resolveTargetPaths({ t3Home: root });
  process.env.T3_IMPORT_DATA_DIR = join(root, "new-ledger");
  expect((await importConversations([{ conversation, resume: true }], v2Paths, { dryRun: false, resume: true })).status).toBe("already-imported");
  addTurn(conversation);
  const synced = await syncConversations([{ conversation }], v2Paths, { dryRun: false });
  expect(synced.results[0]).toMatchObject({ threadId, turnsAdded: 1 });
  expect((await syncConversations([{ conversation }], v2Paths, { dryRun: false })).status).toBe("up-to-date");
  const projected = new Database(v2Path, { readonly: true });
  try { expect((projected.prepare("SELECT count(*) n FROM orchestration_v2_projection_messages").get() as { n: number }).n).toBe(4); }
  finally { projected.close(); }
  await expect(syncConversations([], paths, { dryRun: false })).rejects.toMatchObject({ exitCode: 4, message: expect.stringContaining("frozen") });
});

it("preserves local titles and refuses a rebound native session", async () => {
  const paths = createTarget(root, migration);
  const conversation = canonicalConversation(root);
  const first = await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true });
  const threadId = first.results[0]!.threadId!;
  const db = new Database(paths.dbPath, { readonly: true });
  const thread = JSON.parse((db.prepare("SELECT payload_json payload FROM orchestration_v2_projection_threads").get() as { payload: string }).payload);
  const provider = JSON.parse((db.prepare("SELECT payload_json payload FROM orchestration_v2_projection_provider_threads").get() as { payload: string }).payload);
  db.close();
  const runtime = await officialRuntime();
  await runtime.writeEvents(paths.dbPath, [{ id: "local-rename", type: "thread.metadata-updated", threadId, occurredAt: thread.updatedAt, payload: { ...thread, title: "Local title" } }]);
  conversation.threads[0]!.title = "Provider title";
  const synced = await syncConversations([{ conversation }], paths, { dryRun: false });
  expect(synced.results[0]).toMatchObject({ status: "up-to-date", titleAction: "preserved-local" });
  await runtime.writeEvents(paths.dbPath, [{ id: "native-rebind", type: "provider-thread.updated", threadId, occurredAt: provider.updatedAt, payload: { ...provider, nativeThreadRef: { ...provider.nativeThreadRef, nativeId: "different-session" } } }]);
  addTurn(conversation);
  const count = eventCount(paths.dbPath);
  expect((await syncConversations([{ conversation }], paths, { dryRun: false })).results[0]).toMatchObject({ status: "history-diverged" });
  await expect(replaceConversations([{ conversation }], paths, { dryRun: false })).rejects.toMatchObject({ exitCode: 4 });
  expect(eventCount(paths.dbPath)).toBe(count);
});

it("refuses pending legacy hydration and queued V2 runs", async () => {
  const paths = createTarget(root, migration);
  const conversation = canonicalConversation(root);
  const first = await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true });
  const threadId = first.results[0]!.threadId!;
  const db = new Database(paths.dbPath);
  db.prepare("INSERT INTO orchestration_v2_legacy_imports (thread_id,source_updated_at,shell_imported_at) VALUES (?,?,?)").run(threadId, conversation.threads[0]!.updatedAt, conversation.threads[0]!.updatedAt);
  db.close();
  await expect(inspectConversationSync(conversation, paths)).rejects.toMatchObject({ exitCode: 4, message: expect.stringContaining("migrating") });
  const hydrated = new Database(paths.dbPath);
  hydrated.prepare("UPDATE orchestration_v2_legacy_imports SET transcript_imported_at=shell_imported_at").run();
  hydrated.prepare("INSERT INTO orchestration_v2_effect_outbox (effect_id,command_id,thread_id,effect_type,payload_json,status,attempt_count,available_at,created_at,updated_at) VALUES ('pending-effect','command',?,'provider-turn.start','{}','pending',0,?,?,?)").run(threadId, conversation.threads[0]!.updatedAt, conversation.threads[0]!.updatedAt, conversation.threads[0]!.updatedAt);
  hydrated.close();
  await expect(inspectConversationSync(conversation, paths)).rejects.toMatchObject({ exitCode: 4, message: expect.stringContaining("unfinished") });
  const settledEffect = new Database(paths.dbPath);
  settledEffect.prepare("UPDATE orchestration_v2_effect_outbox SET status='cancelled'").run();
  settledEffect.close();
  const runtime = await officialRuntime();
  await runtime.writeEvents(paths.dbPath, [{ id: "queued-run", type: "run.created", threadId, occurredAt: conversation.threads[0]!.updatedAt,
    payload: { id: "queued", threadId, ordinal: 1, providerInstanceId: "codex", modelSelection: { instanceId: "codex", model: "gpt-test" },
      providerThreadId: null, userMessageId: "queued-user", rootNodeId: null, activeAttemptId: null, status: "queued",
      requestedAt: conversation.threads[0]!.updatedAt, startedAt: null, completedAt: null, checkpointId: null, contextHandoffId: null } }]);
  const before = eventCount(paths.dbPath);
  await expect(syncConversations([{ conversation }], paths, { dryRun: false })).rejects.toMatchObject({ exitCode: 4, message: expect.stringContaining("unfinished") });
  expect(eventCount(paths.dbPath)).toBe(before);
});

it("preserves a native scratch cwd through V2 sync and replacement", async () => {
  const paths = createTarget(root, migration);
  const scratch = join(root, "scratch", "existing-thread");
  mkdirSync(scratch, { recursive: true });
  writeFileSync(join(scratch, "keep.txt"), "user data");
  const conversation = canonicalConversation(scratch);
  const imported = await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true, noProject: true });
  expect(imported.results[0]!.workingDirectory).toBe(scratch);
  addTurn(conversation);
  await syncConversations([{ conversation }], paths, { dryRun: false });
  const replaced = await replaceConversations([{ conversation }], paths, { dryRun: false });
  const db = new Database(paths.dbPath, { readonly: true });
  try {
    const row = db.prepare("SELECT json_extract(payload_json,'$.worktreePath') cwd FROM orchestration_v2_projection_threads WHERE thread_id=?").get(replaced.results[0]!.newThreadId) as { cwd: string };
    expect(row.cwd).toBe(scratch);
  } finally { db.close(); }
  expect(readFileSync(join(scratch, "keep.txt"), "utf8")).toBe("user data");
});

it.each(["codex", "opencode"] as const)("adopts a native %s continuation and appends external history after its run positions", async (source) => {
  const paths = createTarget(root, migration);
  const conversation = canonicalConversation(root);
  const imported = await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true });
  const threadId = imported.results[0]!.threadId!;
  const db = new Database(paths.dbPath, { readonly: true });
  const provider = JSON.parse((db.prepare("SELECT payload_json payload FROM orchestration_v2_projection_provider_threads").get() as { payload: string }).payload);
  db.close();
  addTurn(conversation);
  const turn = conversation.threads[0]!.turns[1]!;
  const runtime = await officialRuntime();
  const events = [
    { id: "run-2-created", type: "run.created", threadId, occurredAt: turn.startedAt, payload: {
      id: "native-run-2", threadId, ordinal: 1, providerInstanceId: "codex", modelSelection: { instanceId: "codex", model: "gpt-test" },
      providerThreadId: provider.id, userMessageId: "native-user-2", rootNodeId: null, activeAttemptId: null,
      status: "completed", requestedAt: turn.startedAt, startedAt: turn.startedAt, completedAt: turn.completedAt,
      checkpointId: null, contextHandoffId: null,
    } },
    ...[turn.user, turn.assistant[0]!].flatMap((message, index) => {
      const id = index ? "native-assistant-2" : "native-user-2";
      const base = { id: `item-${id}`, threadId, runId: "native-run-2", nodeId: null,
        providerThreadId: provider.id, providerTurnId: "native-turn-2", nativeItemRef: null,
        parentItemId: null, ordinal: 0, status: "completed", title: null,
        startedAt: message.timestamp, completedAt: message.timestamp, updatedAt: message.timestamp };
      return [
        { id: `${id}-event`, threadId, type: "message.updated", occurredAt: message.timestamp,
          payload: { id, threadId, runId: "native-run-2", nodeId: null, role: message.role, text: message.text,
            attachments: [], streaming: false, createdBy: index ? "agent" : "user", creationSource: "provider",
            createdAt: message.timestamp, updatedAt: message.timestamp } },
        { id: `${id}-item-event`, threadId, type: "turn-item.updated", occurredAt: message.timestamp,
          payload: { ...base, type: index ? "assistant_message" : "user_message", messageId: id, text: message.text,
            ...(index ? { streaming: false } : { attachments: [], inputIntent: "turn_start", createdBy: "user", creationSource: "provider" }) } },
      ];
    }),
    { id: "native-turn-2-event", threadId, type: "provider-turn.updated", occurredAt: turn.completedAt,
      payload: { id: "native-turn-2", providerThreadId: provider.id, nodeId: "native-node-2", runAttemptId: null,
        nativeTurnRef: { driver: source, nativeId: turn.id, strength: source === "codex" ? "strong" : "weak" }, ordinal: 1, status: "completed",
        startedAt: turn.startedAt, completedAt: turn.completedAt } },
  ];
  await runtime.writeEvents(paths.dbPath, events);
  addTurn(conversation);
  const result = await syncConversations([{ conversation }], paths, { dryRun: false });
  expect(result.results[0]).toMatchObject({ turnsAdopted: 1, turnsAdded: 1 });
  const projected = new Database(paths.dbPath, { readonly: true });
  try {
    const users = projected.prepare("SELECT json_extract(payload_json,'$.text') text, ordinal FROM orchestration_v2_projection_turn_items WHERE type='user_message' ORDER BY ordinal").all() as Array<{ text: string; ordinal: number }>;
    expect(users.map((row) => row.text)).toEqual(["Hello", "Question 2", "Question 3"]);
    expect(users[1]!.ordinal).toBeGreaterThan(1_000_000);
    expect(users[2]!.ordinal).toBeGreaterThan(users[1]!.ordinal);
  } finally { projected.close(); }
  expect((await syncConversations([{ conversation }], paths, { dryRun: false })).status).toBe("up-to-date");
});

it("keeps native provider-managed subagents outside writable synchronization", async () => {
  const paths = createTarget(root, migration);
  const conversation = canonicalConversation(root);
  const first = await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true });
  const threadId = first.results[0]!.threadId!;
  const db = new Database(paths.dbPath, { readonly: true });
  const thread = JSON.parse((db.prepare("SELECT payload_json payload FROM orchestration_v2_projection_threads").get() as { payload: string }).payload);
  db.close();
  const runtime = await officialRuntime();
  await runtime.writeEvents(paths.dbPath, [{ id: "native-subagent-lineage", threadId, type: "thread.metadata-updated", occurredAt: thread.updatedAt,
    payload: { ...thread, creationSource: "provider", lineage: { parentThreadId: "parent", relationshipToParent: "subagent", rootThreadId: "parent" } } }]);
  addTurn(conversation);
  const before = eventCount(paths.dbPath);
  expect((await syncConversations([{ conversation }], paths, { dryRun: false })).results[0]!.status).toBe("history-diverged");
  const all = await syncAllLinkedConversations({ name: "codex", discover: async () => [conversation.summary], load: async () => conversation }, paths, { dryRun: false });
  expect(all.results).toEqual([]);
  expect(eventCount(paths.dbPath)).toBe(before);
});

});
