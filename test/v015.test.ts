import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { canonicalConversation, createTarget } from "./helpers.js";
import { importConversations } from "../src/target/importer.js";
import { syncConversations } from "../src/target/sync.js";
import { replaceConversations } from "../src/target/replace.js";
import { assertV2ThreadSettled } from "../src/target/v2.js";
import { inspectRuntimeActivity } from "../src/target/runtimeActivity.js";

let root: string;
let previousLedger: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t3-v015-"));
  previousLedger = process.env.T3_IMPORT_DATA_DIR;
  process.env.T3_IMPORT_DATA_DIR = join(root, "ledger");
});
afterEach(() => {
  if (previousLedger === undefined) delete process.env.T3_IMPORT_DATA_DIR;
  else process.env.T3_IMPORT_DATA_DIR = previousLedger;
  rmSync(root, { recursive: true, force: true });
});

it("preserves peer configuration and link-origin metadata during import and sync", async () => {
  const paths = createTarget(root, 72);
  const db = new Database(paths.dbPath);
  db.prepare(`INSERT INTO peer_environment_links
    (environment_id,secret_name,label,urls_json,access,linked_at,expires_at,fenced)
    VALUES ('peer','secret-store-reference','Peer','[]','full-access','2026-01-01','2999-01-01',1)`).run();
  const peer = db.prepare("SELECT * FROM peer_environment_links").all();
  db.close();
  const conversation = canonicalConversation(root);
  const imported = await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true });
  const threadId = imported.results[0]!.threadId!;
  const current = new Database(paths.dbPath);
  const payload = JSON.parse((current.prepare("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?").get(threadId) as { payload_json: string }).payload_json);
  current.close();
  const linkOrigin = { sessionId: "peer-session", label: "Linked peer", access: "full-access" };
  const delegatedFrom = { environmentId: "peer", threadId: "remote-parent", title: "Remote parent" };
  const runtime = await import(new URL("../vendor/t3-v015/runtime.mjs", import.meta.url).href);
  await runtime.writeEvents(paths.dbPath, [{ id: "link-metadata", threadId, type: "thread.metadata-updated", occurredAt: payload.updatedAt, payload: { ...payload, linkOrigin, delegatedFrom } }]);
  conversation.threads[0]!.title = "Renamed linked task";
  conversation.summary.title = "Renamed linked task";
  conversation.fingerprint = "rename";
  await syncConversations([{ conversation }], paths, { dryRun: false });
  const synced = new Database(paths.dbPath);
  try {
    const thread = JSON.parse((synced.prepare("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?").get(threadId) as { payload_json: string }).payload_json);
    expect(thread).toMatchObject({ title: "Renamed linked task", linkOrigin, delegatedFrom });
    expect(synced.prepare("SELECT * FROM peer_environment_links").all()).toEqual(peer);
  } finally { synced.close(); }
  await replaceConversations([{ conversation }], paths, { dryRun: false });
  const replaced = new Database(paths.dbPath, { readonly: true });
  try { expect(replaced.prepare("SELECT * FROM peer_environment_links").all()).toEqual(peer); }
  finally { replaced.close(); }
});

it("keeps waiting link cards busy and refuses sync/replace without changing the database", async () => {
  const paths = createTarget(root, 72);
  const conversation = canonicalConversation(root);
  const imported = await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true });
  const threadId = imported.results[0]!.threadId!;
  const db = new Database(paths.dbPath);
  db.prepare(`INSERT INTO orchestration_v2_projection_turn_items
    (turn_item_id,thread_id,ordinal,type,status,updated_at,payload_json)
    VALUES ('link',?,100,'link_request','waiting','2026-01-01','{}')`).run(threadId);
  db.close();
  expect(inspectRuntimeActivity(paths)).toMatchObject({ status: "busy", counts: { v2_active_turn_items: 1 } });
  const before = readFileSync(paths.dbPath);
  await expect(syncConversations([{ conversation }], paths, { dryRun: false })).rejects.toMatchObject({ exitCode: 4 });
  await expect(replaceConversations([{ conversation }], paths, { dryRun: false })).rejects.toMatchObject({ exitCode: 4 });
  expect(readFileSync(paths.dbPath)).toEqual(before);
});

it.each([
  { status: "completed", result: null, stoppedThere: undefined, busy: true },
  { status: "cancelled", result: "done", stoppedThere: undefined, busy: true },
  { status: "interrupted", result: "done", stoppedThere: false, busy: true },
  { status: "completed", result: "done", stoppedThere: false, busy: true },
  { status: "completed", result: "done", stoppedThere: undefined, busy: false },
  { status: "cancelled", result: "done", stoppedThere: true, busy: false },
])("checks remote work and owed stops: $status / $stoppedThere / $result", ({ status, result, stoppedThere, busy }) => {
  const paths = createTarget(root, 72);
  const db = new Database(paths.dbPath);
  try {
    const payload = { status, result, remoteChild: { environmentId: "peer", threadId: "remote", stoppedThere } };
    db.prepare(`INSERT INTO orchestration_v2_projection_subagents
      (subagent_id,thread_id,parent_node_id,provider,origin,status,updated_at,payload_json)
      VALUES ('task','parent','node','codex','app_owned',?,'2026-01-01',?)`).run(status, JSON.stringify(payload));
    expect(inspectRuntimeActivity(paths)).toMatchObject({ status: busy ? "busy" : "idle", counts: { v2_open_remote_tasks: busy ? 1 : 0 } });
    if (busy) expect(() => assertV2ThreadSettled(db, "parent")).toThrow("unfinished work");
    else expect(() => assertV2ThreadSettled(db, "parent")).not.toThrow();
    expect(() => assertV2ThreadSettled(db, "unrelated")).not.toThrow();
  } finally { db.close(); }
});
