import Database from "better-sqlite3";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalConversation, createTarget } from "./helpers.js";
import { createBackup, importConversations } from "../src/target/importer.js";
import { syncConversations } from "../src/target/sync.js";
import { replaceConversations } from "../src/target/replace.js";
import { validateTargetDatabase } from "../src/target/schema.js";

describe.each([69, 72, 76])("message search at migration %i", (migration) => {
let root: string;
let previousLedger: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t3-v013-"));
  previousLedger = process.env.T3_IMPORT_DATA_DIR;
  process.env.T3_IMPORT_DATA_DIR = join(root, "ledger");
});
afterEach(() => {
  if (previousLedger === undefined) delete process.env.T3_IMPORT_DATA_DIR;
  else process.env.T3_IMPORT_DATA_DIR = previousLedger;
  rmSync(root, { recursive: true, force: true });
});

function matches(db: Database.Database, term: string): number {
  return (db.prepare(`SELECT COUNT(*) n FROM orchestration_v2_message_search s
    JOIN orchestration_v2_projection_messages m ON m.rowid=s.rowid
    WHERE orchestration_v2_message_search MATCH ?`).get(term) as { n: number }).n;
}

it("indexes imported, synchronized and replaced messages through official triggers", async () => {
  const paths = createTarget(root, migration);
  const conversation = canonicalConversation(root);
  conversation.threads[0]!.turns[0]!.assistant[0]!.text = "Searchable original answer";
  await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true });
  const db = new Database(paths.dbPath);
  try { expect(matches(db, "original")).toBe(1); } finally { db.close(); }
  const turn = structuredClone(conversation.threads[0]!.turns[0]!);
  turn.id = "turn-2";
  turn.user.sourceId = "user-2";
  turn.user.text = "Searchable second question";
  turn.assistant[0]!.sourceId = "assistant-2";
  turn.assistant[0]!.text = "Searchable second answer";
  conversation.threads[0]!.turns.push(turn);
  conversation.fingerprint = "two-turns";
  expect((await syncConversations([{ conversation }], paths, { dryRun: false })).status).toBe("synced");
  const synced = new Database(paths.dbPath);
  try { expect(matches(synced, "second")).toBe(2); } finally { synced.close(); }
  await replaceConversations([{ conversation }], paths, { dryRun: false });
  const replaced = new Database(paths.dbPath);
  try {
    // Replacement retains the soft-deleted original thread's messages too.
    expect(matches(replaced, "second")).toBe(4);
    replaced.prepare("UPDATE orchestration_v2_projection_messages SET payload_json=json_set(payload_json,'$.text','Changed searchable answer') WHERE role='assistant'").run();
    expect(matches(replaced, "original")).toBe(0);
    expect(matches(replaced, "Changed")).toBe(4);
    replaced.prepare("DELETE FROM orchestration_v2_projection_messages WHERE role='assistant'").run();
    expect(matches(replaced, "Changed")).toBe(0);
  } finally { replaced.close(); }
});

it("imports without the optional FTS extension", async () => {
  const paths = createTarget(root, migration);
  const db = new Database(paths.dbPath);
  db.exec(`DROP TRIGGER orchestration_v2_message_search_insert;
    DROP TRIGGER orchestration_v2_message_search_update;
    DROP TRIGGER orchestration_v2_message_search_delete;
    DROP TABLE orchestration_v2_message_search`);
  expect(validateTargetDatabase(db).migration).toBe(migration);
  db.close();
  expect((await importConversations([{ conversation: canonicalConversation(root), resume: true }], paths, { dryRun: false, resume: true })).status).toBe("imported");
});

it("refuses an incomplete FTS extension before writing", async () => {
  const paths = createTarget(root, migration);
  const db = new Database(paths.dbPath);
  db.exec("DROP TRIGGER orchestration_v2_message_search_update");
  db.close();
  const before = readFileSync(paths.dbPath);
  await expect(importConversations([{ conversation: canonicalConversation(root), resume: true }], paths, { dryRun: false, resume: true })).rejects.toMatchObject({ exitCode: 3, message: expect.stringContaining("Incomplete T3 message search index") });
  expect(readFileSync(paths.dbPath)).toEqual(before);
});

it("preserves message rowids and FTS results in recovery backups", async () => {
  const paths = createTarget(root, migration);
  const conversation = canonicalConversation(root);
  conversation.threads[0]!.turns[0]!.assistant[0]!.text = "Searchable recovery answer";
  await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true });
  const db = new Database(paths.dbPath);
  try {
    // Leave a rowid gap: VACUUM INTO renumbers this row and breaks FTS joins.
    db.prepare("DELETE FROM orchestration_v2_projection_messages WHERE role='user'").run();
    const rows = db.prepare("SELECT rowid, message_id FROM orchestration_v2_projection_messages").all();
    const backupPath = await createBackup(db, paths);
    const backup = new Database(backupPath, { readonly: true });
    try {
      expect(backup.prepare("SELECT rowid, message_id FROM orchestration_v2_projection_messages").all()).toEqual(rows);
      expect(matches(backup, "recovery")).toBe(1);
      expect(backup.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally { backup.close(); }
  } finally { db.close(); }
});

});
