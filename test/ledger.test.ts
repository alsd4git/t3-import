import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listImports } from "../src/target/ledger.js";
import { importConversations } from "../src/target/importer.js";
import { canonicalConversation, createTarget } from "./helpers.js";

let originalLedgerDir: string | undefined;

beforeEach(() => { originalLedgerDir = process.env.T3_IMPORT_DATA_DIR; });
afterEach(() => {
  if (originalLedgerDir === undefined) delete process.env.T3_IMPORT_DATA_DIR;
  else process.env.T3_IMPORT_DATA_DIR = originalLedgerDir;
});

function createLegacyLedger(directory: string): void {
  mkdirSync(directory, { recursive: true });
  const db = new Database(join(directory, "ledger.sqlite"));
  db.exec(`
    CREATE TABLE imports (
      target_id TEXT NOT NULL, source TEXT NOT NULL, source_session_id TEXT NOT NULL,
      source_key TEXT NOT NULL, source_fingerprint TEXT NOT NULL, project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL, imported_at TEXT NOT NULL, importer_version TEXT NOT NULL,
      migration INTEGER NOT NULL, first_sequence INTEGER NOT NULL, last_sequence INTEGER NOT NULL,
      resumable INTEGER NOT NULL, backup_path TEXT NOT NULL, warnings_json TEXT NOT NULL,
      PRIMARY KEY (target_id, source_key, thread_id)
    );
    INSERT INTO imports VALUES ('target', 'codex', 'session', 'codex:session', 'fingerprint', 'project', 'thread', '2026-01-01T00:00:00.000Z', '0.1.0', 40, 1, 10, 1, 'backup', '[]');
  `);
  db.close();
}

describe("external ledger migration", () => {
  it("reads a 0.1 ledger without migrating it during preview", async () => {
    const directory = await mkdtemp(join(tmpdir(), "t3-ledger-v1-"));
    process.env.T3_IMPORT_DATA_DIR = directory;
    createLegacyLedger(directory);

    const rows = listImports("target", "codex");
    expect(rows[0]).toMatchObject({ identitySeed: "codex:session", currentSourceKey: "codex:session", sourceTitle: "" });
    const migrated = new Database(join(directory, "ledger.sqlite"), { readonly: true });
    const columns = (migrated.prepare("PRAGMA table_info(imports)").all() as Array<{ name: string }>).map((row) => row.name);
    migrated.close();
    expect(columns).not.toContain("identity_seed");
    expect(columns).not.toContain("checkpoint_json");
    expect(rows[0]!.isCanonical).toBeUndefined();
  });

  it("upgrades a legacy ledger on write, preserving old imports and current checkpoints", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-ledger-upgrade-"));
    const directory = join(root, "ledger");
    process.env.T3_IMPORT_DATA_DIR = directory;
    createLegacyLedger(directory);
    const paths = createTarget(join(root, "t3"));
    const conversation = canonicalConversation(root);
    const imported = await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true });
    expect(imported.status).toBe("imported");
    // Reopening an already upgraded ledger must be harmless as well.
    expect((await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true })).status).toBe("already-imported");
    const db = new Database(join(directory, "ledger.sqlite"), { readonly: true });
    try {
      expect(db.prepare("SELECT COUNT(*) n FROM imports").get()).toEqual({ n: 2 });
      expect(db.prepare("SELECT source_fingerprint, first_sequence, last_sequence FROM imports WHERE source_session_id='session'").get())
        .toEqual({ source_fingerprint: "fingerprint", first_sequence: 1, last_sequence: 10 });
      const current = db.prepare("SELECT checkpoint_version, checkpoint_json, is_canonical FROM imports WHERE source_session_id=?").get(conversation.summary.id) as { checkpoint_version: number; checkpoint_json: string; is_canonical: number };
      expect(current.checkpoint_version).toBe(2);
      expect(JSON.parse(current.checkpoint_json).turns).toHaveLength(1);
      expect(current.is_canonical).toBe(1);
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally { db.close(); }
  });

  it("does not create a ledger directory when inspecting an unimported target", async () => {
    const directory = join(await mkdtemp(join(tmpdir(), "t3-ledger-readonly-")), "absent");
    process.env.T3_IMPORT_DATA_DIR = directory;
    expect(listImports("target", "codex")).toEqual([]);
    expect(existsSync(directory)).toBe(false);
  });
});
