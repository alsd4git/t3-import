import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { zstdCompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalConversation, createTarget } from "./helpers.js";
import { importConversations } from "../src/target/importer.js";
import { inspectConversationSync, syncConversations } from "../src/target/sync.js";
import { replaceConversations } from "../src/target/replace.js";
import { openTargetReadSnapshot } from "../src/target/schema.js";

let root: string;
let previousLedger: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t3-live-dry-run-"));
  previousLedger = process.env.T3_IMPORT_DATA_DIR;
  process.env.T3_IMPORT_DATA_DIR = join(root, "ledger");
});
afterEach(() => {
  if (previousLedger === undefined) delete process.env.T3_IMPORT_DATA_DIR;
  else process.env.T3_IMPORT_DATA_DIR = previousLedger;
  rmSync(root, { recursive: true, force: true });
});

function snapshot(directory: string): Record<string, string> {
  const files: Record<string, string> = {};
  function walk(path: string) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) { files[relative(directory, file) + "/"] = "directory"; walk(file); }
      // SQLite readers can update shared-memory read marks and create an empty WAL.
      // Neither contains committed changes to ledger/target data.
      else if (!file.endsWith("-shm") && !(file.endsWith("-wal") && statSync(file).size === 0)) files[relative(directory, file)] = createHash("sha256").update(readFileSync(file)).digest("hex");
    }
  }
  walk(directory);
  return files;
}

describe.each([40, 76, 79])("live T3 migration %i", (migration) => {
  it("allows read-only dry-runs but still refuses real writes", async () => {
    const paths = createTarget(join(root, "t3"), migration);
    const conversation = canonicalConversation(root);
    await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true });
    const writer = new Database(paths.dbPath);
    writer.pragma("journal_mode=WAL");
    if (migration < 55) writer.prepare("INSERT INTO projection_state (projector,last_applied_sequence,updated_at) VALUES ('test',(SELECT MAX(sequence) FROM orchestration_events),'2026-01-01') ON CONFLICT(projector) DO UPDATE SET last_applied_sequence=excluded.last_applied_sequence").run();
    else writer.prepare("INSERT INTO orchestration_v2_projection_runs (run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES ('other-run','another-thread',1,'codex','running','2026-01-01','{}')").run();
    writeFileSync(paths.runtimeStatePath, JSON.stringify({ pid: process.pid }));
    conversation.threads[0]!.title = "Changed source title";
    const fresh = structuredClone(conversation);
    fresh.threads[0]!.sourceSessionId = "22222222-2222-4222-8222-222222222222";
    fresh.threads[0]!.sourceKey = `codex:${fresh.threads[0]!.sourceSessionId}`;
    const before = snapshot(root);
    try {
      expect((await importConversations([{ conversation: fresh, resume: true }], paths, { dryRun: true, resume: true })).status).toBe("dry-run");
      expect((await syncConversations([{ conversation }], paths, { dryRun: true })).status).toBe("dry-run");
      await replaceConversations([{ conversation }], paths, { dryRun: true });
      expect((await inspectConversationSync(conversation, paths)).status).toBe("syncable");
      expect(snapshot(root)).toEqual(before);
      for (const operation of [
        () => importConversations([{ conversation: fresh, resume: true }], paths, { dryRun: false, resume: true }),
        () => syncConversations([{ conversation }], paths, { dryRun: false }),
        () => replaceConversations([{ conversation }], paths, { dryRun: false }),
      ]) await expect(operation()).rejects.toMatchObject({ exitCode: 4, message: expect.stringContaining("T3 is running") });
      expect(snapshot(root)).toEqual(before);
    } finally { writer.close(); }
  });
});

it("holds one WAL read snapshot while T3 commits new data", () => {
  const paths = createTarget(join(root, "t3"), 76);
  const writer = new Database(paths.dbPath);
  writer.pragma("journal_mode=WAL");
  writer.exec("CREATE TABLE snapshot_probe(value INTEGER); INSERT INTO snapshot_probe VALUES(1)");
  const reader = openTargetReadSnapshot(paths);
  try {
    expect(reader.prepare("SELECT value FROM snapshot_probe").get()).toEqual({ value: 1 });
    writer.prepare("UPDATE snapshot_probe SET value=2").run();
    expect(reader.prepare("SELECT value FROM snapshot_probe").get()).toEqual({ value: 1 });
    expect(() => reader.prepare("UPDATE snapshot_probe SET value=3").run()).toThrow();
  } finally { reader.close(); writer.close(); }
  const next = openTargetReadSnapshot(paths);
  try { expect(next.prepare("SELECT value FROM snapshot_probe").get()).toEqual({ value: 2 }); }
  finally { next.close(); }
});

function cli(home: string, ...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "--t3-home", home, "--no-cache-reset", "--json", ...args], {
    cwd: process.cwd(), encoding: "utf8", timeout: 20_000,
    env: { ...process.env, CODEX_HOME: join(root, "codex"), CLAUDE_CONFIG_DIR: join(root, "claude"), OPENCODE_DB: join(root, "opencode", "missing.db"), CODEX_BIN: join(root, "missing-codex.exe") },
  });
}
const sessionId = "11111111-1111-4111-8111-111111111111";
function rollout(turns: number): string {
  const timestamp = "2026-01-01T00:00:00.000Z";
  const rows: unknown[] = [{ type: "session_meta", payload: { id: sessionId, cwd: root, timestamp }, timestamp }];
  for (let i = 1; i <= turns; i++) rows.push(
    { type: "event_msg", payload: { type: "task_started", turn_id: `turn-${i}`, started_at: timestamp }, timestamp },
    { type: "response_item", payload: { type: "message", id: `user-${i}`, role: "user", content: [{ type: "input_text", text: `Question ${i}` }] }, timestamp },
    { type: "response_item", payload: { type: "message", id: `assistant-${i}`, role: "assistant", content: [{ type: "output_text", text: `Answer ${i}` }] }, timestamp },
    { type: "event_msg", payload: { type: "task_complete", turn_id: `turn-${i}` }, timestamp },
  );
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

it.each(["import", "sync", "replace"])("CLI %s --dry-run needs no --yes and never pauses a live runtime", (command) => {
  const home = join(root, "t3");
  const paths = createTarget(home, 76);
  const sessions = join(root, "codex", "sessions"); mkdirSync(sessions, { recursive: true });
  const source = join(sessions, "fixture.jsonl"); writeFileSync(source, rollout(1));
  const selection = ["--source", "codex", "--workspace", root, "--thread", sessionId, "--non-interactive"];
  if (command !== "import") {
    const initial = cli(home, "import", ...selection, "--yes");
    expect(initial.status, initial.stderr || initial.stdout).toBe(0);
    writeFileSync(source, rollout(2));
  }
  writeFileSync(paths.runtimeStatePath, JSON.stringify({ pid: process.pid }));
  const before = snapshot(root);
  const result = cli(home, "--manage-runtime", command, ...selection, "--dry-run");
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(JSON.parse(result.stdout).status).toBe("dry-run");
  expect(result.stderr).not.toContain("Restoring T3");
  expect(snapshot(root)).toEqual(before);
});

it.each(["import", "sync", "replace"])("rejects incomplete %s dry-run instead of entering the write TUI", (command) => {
  const result = cli(join(root, "t3"), command, "--dry-run");
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stdout).error).toContain("Dry-run");
});

it("sync-all dry-run loads compressed sources with T3 open and leaves all data unchanged", () => {
  const home = join(root, "t3");
  const paths = createTarget(home, 76);
  const sessions = join(root, "codex", "sessions"); mkdirSync(sessions, { recursive: true });
  const source = join(sessions, "fixture.jsonl.zst");
  writeFileSync(source, zstdCompressSync(Buffer.from(rollout(1))));
  const imported = cli(home, "import", "--source", "codex", "--workspace", root, "--all", "--yes", "--non-interactive");
  expect(imported.status, imported.stderr || imported.stdout).toBe(0);
  writeFileSync(source, zstdCompressSync(Buffer.from(rollout(2))));
  writeFileSync(paths.runtimeStatePath, JSON.stringify({ pid: process.pid }));
  const before = snapshot(root);
  const result = cli(home, "--manage-runtime", "sync", "--source", "codex", "--all", "--dry-run");
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ status: "dry-run", hasConflicts: false, backup: null, results: [{ turnsAdded: 1 }] });
  expect(result.stderr).not.toContain("unsettled");
  expect(snapshot(root)).toEqual(before);
});

it("CLI rename-plan prepares a native call while T3 is open without applying the title", () => {
  const home = join(root, "t3");
  const paths = createTarget(home, 76);
  const sessions = join(root, "codex", "sessions"); mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "fixture.jsonl"), rollout(1));
  const imported = cli(home, "import", "--source", "codex", "--workspace", root, "--all", "--yes", "--non-interactive");
  expect(imported.status, imported.stderr || imported.stdout).toBe(0);
  const threadId = JSON.parse(imported.stdout).results[0].threadId as string;
  writeFileSync(paths.runtimeStatePath, JSON.stringify({ pid: process.pid }));
  const before = snapshot(root);
  const result = cli(home, "rename-plan", "--thread", threadId, "--title", "Native title");
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ status: "planned", provisional: true, expected: { threadId }, call: { tool: "t3_thread_update", arguments: { threadId, title: "Native title" } } });
  expect(snapshot(root)).toEqual(before);
});

it("reports busy targets individually in a dry-run and still refuses their real sync", async () => {
  const paths = createTarget(join(root, "t3"), 76);
  const busy = canonicalConversation(root);
  const idle = structuredClone(busy);
  idle.threads[0]!.sourceKey = "codex:idle-session";
  idle.threads[0]!.sourceSessionId = "idle-session";
  idle.threads[0]!.resumeCursor = { threadId: "idle-session" };
  idle.summary.id = "idle-session";
  const imported = await importConversations([{ conversation: busy, resume: true }, { conversation: idle, resume: true }], paths, { dryRun: false, resume: true });
  const writer = new Database(paths.dbPath);
  try {
    writer.prepare("INSERT INTO orchestration_v2_projection_runs (run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES ('busy-run',?,1,'codex','running','2026-01-01','{}')").run(imported.results[0]!.threadId);
  } finally { writer.close(); }
  busy.threads[0]!.title = "Busy new title";
  idle.threads[0]!.title = "Idle new title";
  const before = snapshot(root);
  const result = await syncConversations([{ conversation: busy }, { conversation: idle }], paths, { dryRun: true });
  expect(result).toMatchObject({ status: "dry-run", hasConflicts: true, backup: null, results: [{ status: "target-busy", turnsAdded: 0, events: 0 }, { status: "dry-run", titleAction: "updated" }] });
  expect(await inspectConversationSync(busy, paths)).toMatchObject({ status: "target-busy", selectable: false });
  await expect(syncConversations([{ conversation: busy }], paths, { dryRun: false })).rejects.toMatchObject({ exitCode: 4, message: expect.stringContaining("unfinished work") });
  expect(snapshot(root)).toEqual(before);
});

it("allows list/show/doctor/links/runtime status with T3 open without modifying data", () => {
  const home = join(root, "t3");
  const paths = createTarget(home, 76);
  const sessions = join(root, "codex", "sessions"); mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "fixture.jsonl"), rollout(1));
  writeFileSync(paths.runtimeStatePath, JSON.stringify({ pid: process.pid }));
  const before = snapshot(root);
  for (const args of [
    ["list", "--source", "codex", "--workspace", root],
    ["show", "--source", "codex", "--thread", sessionId, "--workspace", root],
    ["doctor"], ["links"], ["runtime", "status"],
  ]) {
    const result = cli(home, ...args);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  }
  expect(snapshot(root)).toEqual(before);
});

it("still refuses the frozen V1 database of a migrated home during dry-run", async () => {
  const paths = createTarget(join(root, "t3"), 40);
  writeFileSync(join(paths.stateDir, "statev2.sqlite"), "new database sentinel");
  const before = snapshot(root);
  await expect(importConversations([{ conversation: canonicalConversation(root), resume: true }], paths, { dryRun: true, resume: true })).rejects.toMatchObject({ exitCode: 4, message: expect.stringContaining("frozen pre-upgrade copy") });
  expect(snapshot(root)).toEqual(before);
});
