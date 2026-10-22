import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { OpenCodeSource } from "../src/sources/opencode.js";
import type { SourceSummary } from "../src/core/types.js";

const originalDb = process.env.OPENCODE_DB;
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const temporaryRoots = new Set<string>();
afterEach(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
  temporaryRoots.clear();
  if (originalDb === undefined) delete process.env.OPENCODE_DB;
  else process.env.OPENCODE_DB = originalDb;
  if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalXdgDataHome;
});

const schema = `
CREATE TABLE session_v2 (
  id text PRIMARY KEY, parent_id text, fork_session_id text, directory text NOT NULL,
  title text, version text NOT NULL, agent text, model text,
  time_created integer NOT NULL, time_updated integer NOT NULL, time_idle integer, idle_outcome text
  , time_archived integer
);
CREATE TABLE session_message (
  id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL,
  time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
);
`;

function setupDb(path: string, filePath: string): Database.Database {
  const db = new Database(path);
  db.exec(schema);
  db.prepare(`INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "root", null, null, "/work/app", "A sample task", "2.1.2", "build", JSON.stringify({ id: "claude-test", providerID: "anthropic", variant: "high" }), 1_760_000_000_000, 1_760_000_011_000, null, null, null,
  );
  db.prepare(`INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "child", "root", null, "/work/app", "Child task", "2.1.2", "subagent", null, 1_760_000_001_000, 1_760_000_002_000, 1_760_000_002_000, "succeeded", null,
  );
  db.prepare(`INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "archived", null, null, "/work/app", "Archived", "2.1.2", "build", null, 1_760_000_001_000, 1_760_000_002_000, null, null, 1_760_000_002_000,
  );
  const insert = db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)");
  const msg = (id: string, type: string, seq: number, data: Record<string, unknown>, second = seq) => insert.run(id, "root", type, seq, 1_760_000_000_000 + second * 1000, 1_760_000_000_000 + second * 1000, JSON.stringify(data));
  msg("u1", "user", 1, { text: "first prompt", files: [
    { path: filePath, mime: "image/png", filename: "reference.png" },
    { url: pathToFileURL(filePath).toString(), filename: "file-url.png" },
    { url: "data:image/png;base64,aGVsbG8=", filename: "inline.png" },
    { url: "javascript:alert(1)", filename: "unsafe.png" },
  ] });
  msg("a1", "assistant", 2, { model: { providerID: "anthropic", modelID: "claude-test" }, content: [
    { type: "text", text: "first answer" },
    { type: "reasoning", text: "reasoning detail", time: { start: 1, end: 2 } },
    { type: "tool", id: "tool-1", name: "read", state: { status: "completed", input: { file: "src/index.ts" }, content: "file contents" } },
    { type: "text", text: "second answer" },
  ], finish: "tool-calls", time: { created: 1_760_000_002_000, completed: 1_760_000_003_000 } });
  msg("idle1", "idle", 3, { outcome: "succeeded" }, 3);
  msg("u2", "user", 4, { text: "second prompt" });
  msg("a2", "assistant", 5, { content: [{ type: "text", text: "partial answer" }], finish: "error", error: { name: "ProviderError", message: "provider unavailable" }, time: { created: 1_760_000_004_000, completed: 1_760_000_005_000 } });
  msg("a2-retry", "assistant", 6, { content: [{ type: "text", text: "recovered answer" }], finish: "stop" });
  msg("idle2", "idle", 7, { outcome: "succeeded" });
  msg("u4", "user", 8, { text: "follow-up prompt" });
  msg("system4", "system", 9, { text: "private system context" });
  msg("synthetic4", "synthetic", 10, { text: "private synthetic context" });
  msg("a4", "assistant", 11, { finish: "error", error: { message: "final provider error" } });
  msg("idle4", "idle", 12, { outcome: "failed" });
  msg("u5", "user", 13, { text: "unfinished prompt" });
  msg("a5", "assistant", 14, { content: [{ type: "text", text: "still working" }], finish: "tool-calls" });
  return db;
}

async function temporaryDatabase(): Promise<{ root: string; dbPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "t3-import-opencode-"));
  temporaryRoots.add(root);
  const dataDirectory = join(root, "opencode");
  mkdirSync(dataDirectory);
  return { root, dbPath: join(dataDirectory, "opencode.db") };
}

describe("OpenCode V2 source adapter", () => {
  it("discovers root sessions only, respects workspace/since filters and uses the configured DB", async () => {
    const { root, dbPath } = await temporaryDatabase();
    process.env.OPENCODE_DB = dbPath;
    process.env.XDG_DATA_HOME = join(root, "unused");
    const filePath = join(root, "reference.png");
    writeFileSync(filePath, "image-fixture");
    const db = setupDb(dbPath, filePath);
    db.close();

    const adapter = new OpenCodeSource();
    const summaries = await adapter.discover({ workspace: "/work/app" });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      source: "opencode",
      id: "root",
      title: "A sample task",
      workspace: "/work/app",
      path: dbPath,
      status: "incomplete",
    });
    expect(summaries.map((summary) => summary.id)).toEqual(["root"]);
    expect(await adapter.discover({ workspace: "/other" })).toEqual([]);
    expect(await adapter.discover({ since: new Date("2026-01-01T00:00:00Z") })).toEqual([]);
  });

  it("maps user-ID turns, text, reasoning, tool calls, attachments, provider model and terminal failures", async () => {
    const { root, dbPath } = await temporaryDatabase();
    process.env.OPENCODE_DB = dbPath;
    const filePath = join(root, "reference.png");
    writeFileSync(filePath, "image-fixture");
    const db = setupDb(dbPath, filePath);
    db.close();
    const adapter = new OpenCodeSource();
    const summary = (await adapter.discover({}))[0]!;
    const conversation = await adapter.load(summary, {});
    const thread = conversation.threads[0]!;

    expect(thread).toMatchObject({
      source: "opencode",
      sourceSessionId: "root",
      sourceKey: "opencode:root",
      resumeCursor: { sessionId: "root", headMessageId: "u4" },
      model: "anthropic/claude-test",
      modelOptions: [{ id: "variant", value: "high" }],
      workspace: "/work/app",
      title: "A sample task",
      ignoredInProgressTurns: 1,
    });
    expect(thread.turns).toHaveLength(3);
    expect(thread.turns[0]).toMatchObject({ id: "u1", status: "completed", user: { text: "first prompt" } });
    expect(thread.turns[0]!.user.attachments[0]).toMatchObject({ name: "reference.png", mimeType: "image/png", path: filePath, sizeBytes: 13 });
    expect(thread.turns[0]!.user.attachments[1]).toMatchObject({ name: "file-url.png", mimeType: "application/octet-stream", path: filePath, sizeBytes: 13 });
    expect(thread.turns[0]!.user.attachments[2]).toMatchObject({ name: "inline.png", mimeType: "image/png", sizeBytes: 5, data: Buffer.from("hello") });
    expect(thread.turns[0]!.user.attachments).toHaveLength(3);
    expect(thread.warnings).toContain("Skipped attachment with unsupported URL scheme u1:3.");
    expect(thread.turns[0]!.assistant).toHaveLength(1);
    expect(thread.turns[0]!.assistant[0]!.text).toBe("first answer\nsecond answer");
    expect(thread.turns[0]!.activities).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "reasoning.summary", payload: { data: { item: { text: "reasoning detail" } } } }),
      expect.objectContaining({ kind: "tool.completed", payload: expect.objectContaining({ status: "completed", data: expect.objectContaining({ toolCallId: "tool-1" }) }) }),
    ]));
    expect(thread.turns[1]).toMatchObject({ id: "u2", status: "completed" });
    expect(thread.turns[1]!.assistant.map((message) => message.text)).toEqual(["partial answer", "recovered answer"]);
    expect(thread.turns[1]!.activities).toContainEqual(expect.objectContaining({ kind: "provider.error", payload: { detail: "provider unavailable", retryable: true } }));
    expect(thread.turns[2]).toMatchObject({ id: "u4", status: "failed", terminalError: "final provider error" });
    expect(thread.turns[2]!.activities.at(-1)).toMatchObject({ kind: "turn.failed", tone: "error", payload: expect.objectContaining({ detail: "final provider error" }) });
    expect(thread.turns.some((turn) => turn.id === "u3")).toBe(false); // no idle: never fabricate an interrupted terminal state
    expect(thread.warnings).toContain("OpenCode system message system4 was retained in the original provider store and omitted from the visible transcript.");
    expect(thread.warnings).toContain("OpenCode synthetic message synthetic4 was retained in the original provider store and omitted from the visible transcript.");

    const withIncomplete = await adapter.load(summary, { includeIncomplete: true });
    expect(withIncomplete.threads[0]!.turns.map((turn) => turn.id)).toEqual(["u1", "u2", "u4", "u5"]);
    expect(withIncomplete.threads[0]!.turns.at(-1)).toMatchObject({ id: "u5", status: "inProgress" });
  });

  it("fails closed when an incomplete middle user message precedes a later settled turn", async () => {
    const { root, dbPath } = await temporaryDatabase();
    process.env.OPENCODE_DB = dbPath;
    const db = setupDb(dbPath, join(root, "reference.png"));
    const insert = db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)");
    const add = (id: string, type: string, seq: number, data: Record<string, unknown>) => insert.run(id, "root", type, seq, 1_760_000_000_000 + seq * 1000, 1_760_000_000_000 + seq * 1000, JSON.stringify(data));
    add("u6", "user", 15, { text: "later prompt" });
    add("a6", "assistant", 16, { content: [{ type: "text", text: "later answer" }], finish: "stop" });
    add("idle6", "idle", 17, { outcome: "succeeded" });
    db.close();

    const adapter = new OpenCodeSource();
    const summary = (await adapter.discover({}))[0]!;
    await expect(adapter.load(summary, {})).rejects.toThrow(/incomplete user message before a later settled turn/u);
    const completeSnapshot = await adapter.load(summary, { includeIncomplete: true });
    expect(completeSnapshot.threads[0]!.turns.map((turn) => turn.id)).toEqual(["u1", "u2", "u4", "u5", "u6"]);
    expect(completeSnapshot.threads[0]!.turns[3]).toMatchObject({ id: "u5", status: "inProgress" });
    expect(completeSnapshot.threads[0]!.turns[4]).toMatchObject({ id: "u6", status: "completed" });
  });

  it("allows an explicitly selected child session but refuses implicit child loads", async () => {
    const { root, dbPath } = await temporaryDatabase();
    process.env.OPENCODE_DB = dbPath;
    const db = setupDb(dbPath, join(root, "reference.png"));
    const insert = db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)");
    insert.run("child-user", "child", "user", 1, 1_760_000_001_000, 1_760_000_001_000, JSON.stringify({ text: "child prompt" }));
    insert.run("child-idle", "child", "idle", 2, 1_760_000_002_000, 1_760_000_002_000, JSON.stringify({ outcome: "succeeded" }));
    db.close();
    const adapter = new OpenCodeSource();
    const implicit = { source: "opencode", id: "child", title: "Child", workspace: "/work/app", path: dbPath, createdAt: "2025-10-09T08:00:00.000Z", updatedAt: "2025-10-09T08:00:02.000Z", status: "complete", branches: 1 } as unknown as SourceSummary;
    await expect(adapter.load(implicit, {})).rejects.toThrow(/child session.*not selected explicitly/u);
    const explicit = { ...implicit, parentId: "root" };
    const conversation = await adapter.load(explicit, {});
    expect(conversation.threads[0]!.sourceSessionId).toBe("child");
  });

  it("fails clearly for an incompatible OpenCode database schema", async () => {
    const { dbPath } = await temporaryDatabase();
    process.env.OPENCODE_DB = dbPath;
    const db = new Database(dbPath);
    db.exec("CREATE TABLE session (id text)");
    db.close();
    await expect(new OpenCodeSource().discover({})).rejects.toThrow(/supported V2 session schema/u);
  });

  it("rejects non-2.x session versions during discovery", async () => {
    const { dbPath } = await temporaryDatabase();
    process.env.OPENCODE_DB = dbPath;
    const db = new Database(dbPath);
    db.exec(schema);
    db.prepare(`INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "legacy", null, null, "/work/app", "Legacy", "1.19.0", null, null, 1_760_000_000_000, 1_760_000_000_000, null, null, null,
    );
    db.close();
    await expect(new OpenCodeSource().discover({})).rejects.toThrow(/supports OpenCode 2.x sessions/u);
  });
});
