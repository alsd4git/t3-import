import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { canonicalConversation, createTarget } from "./helpers.js";
import { importConversations } from "../src/target/importer.js";
import { syncConversations } from "../src/target/sync.js";
import { inspectRuntimeActivity } from "../src/target/runtimeActivity.js";

let root: string;
let previousLedger: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t3-v018-"));
  previousLedger = process.env.T3_IMPORT_DATA_DIR;
  process.env.T3_IMPORT_DATA_DIR = join(root, "ledger");
});
afterEach(() => {
  if (previousLedger === undefined) delete process.env.T3_IMPORT_DATA_DIR;
  else process.env.T3_IMPORT_DATA_DIR = previousLedger;
  rmSync(root, { recursive: true, force: true });
});
function insertTask(db: Database.Database, id: string, threadId: string | null, next = "2999-01-01T00:00:00.000Z", status = "never") {
  const timestamp = "2026-01-01T00:00:00.000Z";
  db.prepare(`INSERT INTO scheduled_tasks (task_id,title,prompt,enabled,schedule_json,project_id,thread_id,workspace_strategy_json,model_selection_json,runtime_mode,interaction_mode,created_by,creation_source,created_at,updated_at,next_run_at,last_run_status,run_count)
    VALUES (?,?,?,1,?,'project',?,'{}','{}','full-access','default','user','mcp',?,?,?,?,0)`)
    .run(id, "Synthetic task", "prompt", JSON.stringify({ type: "once", runAt: next }), threadId, timestamp, timestamp, next, status);
}

it("upgrades populated 0.1.7 history and assigns existing scheduled task modes without changing their data", async () => {
  const paths = createTarget(root, 79);
  const conversation = canonicalConversation(root);
  const imported = await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true });
  const db = new Database(paths.dbPath);
  let messages: unknown[];let events: unknown[];let tasks: unknown[];
  try {
    insertTask(db, "linked", imported.results[0]!.threadId);
    insertTask(db, "unlinked", null);
    messages = db.prepare("SELECT * FROM orchestration_v2_projection_messages ORDER BY message_id").all();
    events = db.prepare("SELECT * FROM orchestration_events ORDER BY sequence").all();
    tasks = db.prepare("SELECT * FROM scheduled_tasks ORDER BY task_id").all();
  } finally { db.close(); }
  const pinned = await import(new URL("../vendor/t3-v018/runtime.mjs", import.meta.url).href);
  await pinned.createSchema(paths.dbPath);
  const upgraded = new Database(paths.dbPath);
  try {
    expect(upgraded.prepare("SELECT MAX(migration_id) migration FROM effect_sql_migrations").get()).toEqual({ migration: 80 });
    expect(upgraded.prepare("SELECT task_id,thread_mode FROM scheduled_tasks ORDER BY task_id").all()).toEqual([
      { task_id: "linked", thread_mode: "continue" }, { task_id: "unlinked", thread_mode: "new_thread" },
    ]);
    expect(upgraded.prepare("SELECT * FROM scheduled_tasks ORDER BY task_id").all().map((row) => {
      const { thread_mode: _mode, ...fields } = row as Record<string, unknown>;return fields;
    })).toEqual(tasks);
    expect(upgraded.prepare("SELECT * FROM orchestration_v2_projection_messages ORDER BY message_id").all()).toEqual(messages);
    expect(upgraded.prepare("SELECT * FROM orchestration_events ORDER BY sequence").all()).toEqual(events);
    insertTask(upgraded, "created-after-upgrade", null);
    expect(upgraded.prepare("SELECT thread_mode FROM scheduled_tasks WHERE task_id='created-after-upgrade'").get()).toEqual({ thread_mode: "new_thread" });
    expect(upgraded.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(upgraded.pragma("foreign_key_check")).toEqual([]);
  } finally { upgraded.close(); }
  conversation.threads[0]!.title = "Synced after 0.1.8 upgrade";
  expect((await syncConversations([{ conversation }], paths, { dryRun: false })).status).toBe("synced");
  expect((await syncConversations([{ conversation }], paths, { dryRun: false })).status).toBe("up-to-date");
});

it.each(["continue", "new_thread"])("recognizes future, due and running scheduled tasks in %s mode", (mode) => {
  const paths = createTarget(root, 80);
  const db = new Database(paths.dbPath);
  try {
    insertTask(db, "task", mode === "continue" ? "thread" : null);
    db.prepare("UPDATE scheduled_tasks SET thread_mode=?").run(mode);
    expect(inspectRuntimeActivity(paths)).toMatchObject({ status: "idle", counts: { scheduler_future_tasks: 1, scheduler_due_tasks: 0, scheduler_running_tasks: 0 } });
    db.prepare("UPDATE scheduled_tasks SET next_run_at='2000-01-01T00:00:00.000Z'").run();
    expect(inspectRuntimeActivity(paths)).toMatchObject({ status: "busy", counts: { scheduler_due_tasks: 1 } });
    db.prepare("UPDATE scheduled_tasks SET last_run_status='running'").run();
    expect(inspectRuntimeActivity(paths)).toMatchObject({ status: "busy", counts: { scheduler_running_tasks: 1 } });
    db.prepare("UPDATE scheduled_tasks SET enabled=0,last_run_status='succeeded',next_run_at=NULL").run();
    expect(inspectRuntimeActivity(paths)).toMatchObject({ status: "idle" });
  } finally { db.close(); }
});
