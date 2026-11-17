import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { canonicalConversation, createTarget } from "./helpers.js";
import { importConversations } from "../src/target/importer.js";
import { syncConversations } from "../src/target/sync.js";
import { validateTargetDatabase } from "../src/target/schema.js";

let root: string;
let previousLedger: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t3-v0110-"));
  previousLedger = process.env.T3_IMPORT_DATA_DIR;
  process.env.T3_IMPORT_DATA_DIR = join(root, "ledger");
});
afterEach(() => {
  if (previousLedger === undefined) delete process.env.T3_IMPORT_DATA_DIR;
  else process.env.T3_IMPORT_DATA_DIR = previousLedger;
  rmSync(root, { recursive: true, force: true });
});
const citation = `[Assistant quote](t3-citation://v1/local/thread/message?${new URLSearchParams({ text: "lighthouse guides ships", comment: "searchable commentary", start: "0", end: "22", prefix: "", suffix: "" })})`;
function verifySearch(db: Database.Database) {
  expect(db.prepare("SELECT search_text FROM orchestration_v2_projection_messages WHERE role='assistant'").all()).toEqual([{ search_text: "lighthouse guides ships\nComment: searchable commentary" }]);
  expect(db.prepare("SELECT COUNT(*) n FROM orchestration_v2_message_search WHERE orchestration_v2_message_search MATCH 'commentary'").get()).toEqual({ n: 1 });
}
function verifyCounts(db: Database.Database) {
  const actual = db.prepare("SELECT thread_id,run_key,item_count FROM orchestration_v2_projection_turn_item_counts ORDER BY thread_id,run_key").all();
  const expected = db.prepare("SELECT thread_id,COALESCE(run_id,'') run_key,COUNT(*) item_count FROM orchestration_v2_projection_turn_items GROUP BY thread_id,run_id ORDER BY thread_id,run_key").all();
  expect(actual).toEqual(expected);
}
it.each([{ migration: 81, directory: "t3-v019" }, { migration: 96, directory: "t3-v0110" }])("upgrades populated schema 80 to $migration and preserves searchable history through sync", async ({ migration, directory }) => {
  const paths = createTarget(root, 80);
  const conversation = canonicalConversation(root);
  conversation.threads[0]!.turns[0]!.assistant[0]!.text = citation;
  await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true });
  const before = new Database(paths.dbPath);
  const messages = before.prepare("SELECT message_id,payload_json FROM orchestration_v2_projection_messages ORDER BY message_id").all();
  const events = before.prepare("SELECT * FROM orchestration_events ORDER BY sequence").all();
  before.close();
  const runtime = await import(new URL(`../vendor/${directory}/runtime.mjs`, import.meta.url).href);
  await runtime.createSchema(paths.dbPath);
  const db = new Database(paths.dbPath);
  try {
    expect(validateTargetDatabase(db).migration).toBe(migration);
    expect(db.prepare("SELECT message_id,payload_json FROM orchestration_v2_projection_messages ORDER BY message_id").all()).toEqual(messages);
    expect(db.prepare("SELECT * FROM orchestration_events ORDER BY sequence").all()).toEqual(events);
    verifySearch(db);
    if (migration === 96) {
      verifyCounts(db);
      db.prepare("UPDATE projection_projects SET has_custom_title=1").run();
    }
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(db.pragma("foreign_key_check")).toEqual([]);
  } finally { db.close(); }
  conversation.threads[0]!.title = "After upgrade";
  expect((await syncConversations([{ conversation }], paths, { dryRun: false })).status).toBe("synced");
  expect((await syncConversations([{ conversation }], paths, { dryRun: false })).status).toBe("up-to-date");
  const synced = new Database(paths.dbPath);
  try {
    verifySearch(synced);
    if (migration === 96) {
      verifyCounts(synced);
      expect(synced.prepare("SELECT has_custom_title FROM projection_projects").all()).toEqual([{ has_custom_title: 1 }]);
    }
  } finally { synced.close(); }
});
