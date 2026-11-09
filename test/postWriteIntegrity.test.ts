import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { importConversations } from "../src/target/importer.js";
import { committedTargetIntegrity } from "../src/target/schema.js";
import { canonicalConversation, createTarget } from "./helpers.js";

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
it("verifies externally committed FTS segments and records a large searchable V2 import", async () => {
  const root = mkdtempSync(join(tmpdir(), "t3-fts-verification-"));roots.push(root);
  const workspace = join(root, "workspace");mkdirSync(workspace);
  const paths = createTarget(join(root, "t3"), 79);
  const original = process.env.T3_IMPORT_DATA_DIR;process.env.T3_IMPORT_DATA_DIR = join(root, "ledger");
  let seed = 12345;
  const text = () => Array.from({ length: 12_000 }, () => {seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;return String.fromCharCode(32 + seed % 95);}).join("");
  const conversation = canonicalConversation(workspace);const turn = conversation.threads[0]!.turns[0]!;
  conversation.threads[0]!.turns = Array.from({ length: 21 }, (_, i) => ({
    ...turn, id: `turn-${i}`, user: { ...turn.user, sourceId: `user-${i}`, text: `needle${i} ${text()}` },
    assistant: Array.from({ length: 3 }, (_, j) => ({ ...turn.assistant[0]!, sourceId: `assistant-${i}-${j}`, text: text() })), activities: [],
  }));
  try {
    const existing = canonicalConversation(workspace);
    existing.threads[0]!.sourceSessionId = "22222222-2222-4222-8222-222222222222";
    existing.threads[0]!.sourceKey = `codex:${existing.threads[0]!.sourceSessionId}`;
    existing.summary.id = existing.threads[0]!.sourceSessionId;
    existing.threads[0]!.resumeCursor = { threadId: existing.summary.id };
    existing.threads[0]!.turns[0]!.user.text = text();
    await importConversations([{ conversation: existing, resume: true }], paths, { dryRun: false, resume: true });
    const result = await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true });
    expect(result.status).toBe("imported");expect(result.results[0]!.turns).toBe(21);
    expect(committedTargetIntegrity(paths)).toBe("ok");
    const db = new Database(paths.dbPath, { readonly: true });
    try { expect(db.prepare("SELECT count(*) count FROM orchestration_v2_message_search WHERE orchestration_v2_message_search MATCH 'needle'").get()).toEqual({ count: 21 }); }
    finally { db.close(); }
    const ledger = new Database(join(root, "ledger", "ledger.sqlite"), { readonly: true });
    try { expect(ledger.prepare("SELECT count(*) count FROM imports").get()).toEqual({ count: 2 }); }
    finally { ledger.close(); }
  } finally { if (original === undefined) delete process.env.T3_IMPORT_DATA_DIR;else process.env.T3_IMPORT_DATA_DIR = original; }
}, 30_000);
it("still reports genuine FTS damage from the committed database", () => {
  const root = mkdtempSync(join(tmpdir(), "t3-fts-damage-"));roots.push(root);
  const paths = createTarget(join(root, "t3"), 79);
  const db = new Database(paths.dbPath);
  try {
    db.exec("INSERT INTO orchestration_v2_message_search (rowid,text) VALUES (1,'searchable fixture text')");
    db.unsafeMode(true); // Deliberately damage this disposable fixture only.
    db.exec("DELETE FROM orchestration_v2_message_search_data WHERE id > 10");
  } finally { db.close(); }
  let observed: string;
  try { observed = committedTargetIntegrity(paths); }
  catch (error) { observed = error instanceof Error ? error.message : String(error); }
  expect(observed).toMatch(/corrupt|malformed/iu);
});
