import React from "react";
import Database from "better-sqlite3";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { conversationStatusText, discoverTuiDestinations, escapeDestination, helpTextForScreen, ImportTui, replacementStatusText, ReplacementReview, selectionMarker, sourceLabel, StartT3Prompt } from "../src/tui.js";
import type { ConversationReplacePreview, ConversationSyncPreview, TargetPaths } from "../src/core/types.js";
import { sourceNames } from "../src/core/providers.js";
import { canonicalConversation, createTarget } from "./helpers.js";

const paths: TargetPaths = {
  t3Home: "C:\\fixture\\.t3",
  stateDir: "C:\\fixture\\.t3\\userdata",
  dbPath: "C:\\fixture\\.t3\\userdata\\state.sqlite",
  attachmentsDir: "C:\\fixture\\.t3\\userdata\\attachments",
  runtimeStatePath: "C:\\fixture\\.t3\\userdata\\server-runtime.json",
  settingsPath: "C:\\fixture\\.t3\\userdata\\settings.json",
};

async function waitForFrame(
  tui: { lastFrame(): string | undefined },
  expected: string,
  timeoutMs = 2_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = tui.lastFrame() ?? "";
    if (frame.includes(expected)) {
      // Ink writes the frame during commit, before useInput's passive effect
      // refreshes its listener. Let that effect settle before tests send input.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const settledFrame = tui.lastFrame() ?? "";
      if (settledFrame.includes(expected)) return settledFrame;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for '${expected}'. Last frame:\n${tui.lastFrame() ?? "<none>"}`);
}

describe("interactive TUI", () => {
  it("uses related circle symbols for selectable, selected, and disabled rows", () => {
    expect(selectionMarker(false, false)).toBe("○");
    expect(selectionMarker(true, false)).toBe("◉");
    expect(selectionMarker(false, true)).toBe("⊘");
    expect(selectionMarker(true, true)).toBe("⊘");
  });

  it("advertises only controls supported by each screen", () => {
    expect(helpTextForScreen("source")).toBe("↑/↓ or j/k move  Enter choose  Esc back/quit  q quit");
    expect(helpTextForScreen("workspace")).not.toContain("Space select");
    expect(helpTextForScreen("provider")).not.toContain("/ search");
    expect(helpTextForScreen("destination")).toContain("Enter choose");
    expect(helpTextForScreen("threads")).toContain("Space select  a all  / search");
    expect(helpTextForScreen("threads", true)).toBe("Type to search  Backspace delete  Enter apply  Esc cancel");
    expect(helpTextForScreen("review")).toBe("Enter confirm  Esc back  q quit");
    expect(helpTextForScreen("result")).toBe("↑/↓ or j/k move  Enter confirm  q quit");
    expect(helpTextForScreen("running")).toBeUndefined();
  });

  it("only returns to option screens that were actually visited", () => {
    expect(escapeDestination("threads", ["source"])).toBe("source");
    expect(escapeDestination("threads", ["source", "workspace"])).toBe("workspace");
    expect(escapeDestination("threads", [])).toBeUndefined();
    expect(escapeDestination("review", ["source", "threads", "provider"])).toBe("provider");
  });

  it("uses the documented reconciliation status labels", () => {
    const preview = (status: ConversationSyncPreview["status"], newTurns = 0): ConversationSyncPreview => ({
      sourceId: "fixture", status, newTurns, newCompletedTurns: newTurns, newInterruptedTurns: 0, newFailedTurns: 0, ignoredActiveTurns: 0, adoptedTurns: 0, titleChanged: false,
      selectable: status === "new" || status === "syncable", previouslyImported: status !== "new", warnings: [],
    });
    expect(conversationStatusText(preview("new"), false)).toBe("new");
    expect(conversationStatusText(preview("syncable", 3), false)).toBe("3 new turns");
    expect(conversationStatusText(preview("up-to-date"), false)).toBe("up to date");
    expect(conversationStatusText(preview("history-diverged"), false)).toBe("history changed");
    expect(conversationStatusText(preview("branch-sync-unsupported"), false)).toBe("branch sync unsupported");
    expect(conversationStatusText({ ...preview("syncable", 1), newCompletedTurns: 0, newInterruptedTurns: 1 }, false)).toBe("1 new turn · interrupted");
    expect(conversationStatusText({ ...preview("syncable", 3), newCompletedTurns: 1, newInterruptedTurns: 1, newFailedTurns: 1 }, false)).toBe("3 new turns · 1 interrupted, 1 failed");
    expect(conversationStatusText({ ...preview("up-to-date"), ignoredActiveTurns: 1 }, false)).toBe("up to date · 1 active turn ignored");
    expect(conversationStatusText(preview("active-only"), false)).toBe("active turn only");
    const replacement = (status: ConversationReplacePreview["status"]): ConversationReplacePreview => ({
      sourceId: "fixture", status, selectable: status === "replaceable", previouslyImported: status !== "not-imported",
      turns: 2, events: 12, attachments: 0, warnings: [],
    });
    expect(replacementStatusText(replacement("replaceable"), false)).toBe("replace available");
    expect(replacementStatusText(replacement("already-current"), false)).toBe("already current");
    expect(replacementStatusText(replacement("active-source"), false)).toBe("active source");
    expect(replacementStatusText(replacement("branch-replace-unsupported"), false)).toBe("branch replacement unsupported");
  });

  it("selects starting T3 Code by default on the completion prompt", () => {
    const tui = render(<StartT3Prompt index={0} />);
    expect(tui.lastFrame()).toContain("Start T3 Code now?");
    expect(tui.lastFrame()).toContain("›  Yes");
    expect(tui.lastFrame()).toContain("   No");
    tui.unmount();
  });

  it("shows a replacement-only review without unrelated import and sync counters", () => {
    const conversation = canonicalConversation("C:\\fixtures\\sample-workspace");
    conversation.summary.title = "Synthetic replacement conversation";
    const preview: ConversationReplacePreview = {
      sourceId: conversation.summary.id,
      status: "replaceable",
      selectable: true,
      previouslyImported: true,
      turns: 4,
      events: 36,
      attachments: 2,
      oldThreadId: "old-thread-id",
      newThreadId: "new-thread-id",
      warnings: [],
    };
    const tui = render(<ReplacementReview
      workspace="C:\fixtures\sample-workspace"
      selections={[{ conversation }]}
      previews={new Map([[conversation.summary.id, preview]])}
      counts={{ tasks: 1, turns: 4, events: 36, attachments: 2 }}
      resetCache
    />);
    const frame = tui.lastFrame()!;
    expect(frame).toContain("Review replacement");
    expect(frame).toContain("Old T3 task: old-thread-id");
    expect(frame).toContain("New T3 task: new-thread-id");
    expect(frame).toContain("4 turns · 36 events · 2 attachments");
    expect(frame).toContain("When you confirm, t3-import will automatically:");
    expect(frame).toContain("Create a verified backup of the T3 database");
    expect(frame).toContain("Back up and reset T3's UI cache");
    expect(frame).toContain("Press Enter to replace, or Escape to cancel.");
    expect(frame).not.toContain("New tasks:");
    expect(frame).not.toContain("synchronized tasks:");
    tui.unmount();
  });

  it("supports arrow and vim-style source navigation", async () => {
    const tui = render(<ImportTui paths={paths} />);
    const initialFrame = await waitForFrame(tui, `›  ${sourceLabel(sourceNames[0]!)}`);
    expect(initialFrame).toContain("Choose a source");
    expect(initialFrame).toContain("Enter choose");
    expect(initialFrame).not.toContain("Space select");
    expect(initialFrame).not.toContain("/ search");

    for (let index = 1; index < sourceNames.length; index += 1) {
      tui.stdin.write("j");
      await waitForFrame(tui, `›  ${sourceLabel(sourceNames[index]!)}`);
    }
    for (let index = sourceNames.length - 2; index >= 0; index -= 1) {
      tui.stdin.write("k");
      await waitForFrame(tui, `›  ${sourceLabel(sourceNames[index]!)}`);
    }
    tui.unmount();
  });

  it("offers only same-cwd projects plus No project when canonical policy allows it", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-tui-destination-"));
    try {
      const target = createTarget(join(root, "t3"), 62);
      const workspace = join(root, "workspace");
      mkdirSync(workspace, { recursive: true });
      const otherWorkspace = join(root, "other");
      mkdirSync(otherWorkspace, { recursive: true });
      const db = new Database(target.dbPath);
      try {
        const insert = db.prepare(`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at)
          VALUES (?,?,?,'[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`);
        insert.run("matching", "Matching project", workspace);
        insert.run("different", "Different project", otherWorkspace);
      } finally { db.close(); }

      expect(discoverTuiDestinations(target, workspace)).toEqual([
        { label: "Use the matching workspace project (default)" },
        { label: `Matching project · ${workspace}`, options: { targetProject: "matching" } },
      ]);

      const scratchWorkspace = join(target.t3Home, "scratch", "task");
      mkdirSync(scratchWorkspace, { recursive: true });
      expect(discoverTuiDestinations(target, scratchWorkspace).at(-1)).toEqual({
        label: "No project (T3 scratch)", options: { noProject: true },
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("blocks at startup while the target T3 runtime is live", async () => {
    const root = await mkdtemp(join(tmpdir(), "t3-import-tui-live-"));
    const stateDir = join(root, "userdata");
    mkdirSync(stateDir, { recursive: true });
    const livePaths: TargetPaths = {
      t3Home: root,
      stateDir,
      dbPath: join(stateDir, "state.sqlite"),
      attachmentsDir: join(stateDir, "attachments"),
      runtimeStatePath: join(stateDir, "server-runtime.json"),
      settingsPath: join(stateDir, "settings.json"),
    };
    writeFileSync(livePaths.runtimeStatePath, JSON.stringify({ version: 1, pid: process.pid, origin: "http://127.0.0.1:1" }));
    const tui = render(<ImportTui paths={livePaths} />);
    const frame = await waitForFrame(tui, `detected PID ${process.pid}`);
    expect(frame).toContain("T3 is running");
    expect(frame).not.toContain("Choose a source");
    tui.unmount();
  });
});
