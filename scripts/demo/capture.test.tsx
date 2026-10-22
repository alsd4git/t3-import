import React from "react";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { render } from "ink-testing-library";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { CanonicalConversation, ConversationSyncPreview, SourceSummary } from "../../src/core/types.js";
import { sourceAdapter } from "../../src/sources/index.js";
import { createTarget, canonicalConversation } from "../../test/helpers.js";
import { ImportTui } from "../../src/tui.js";

const syntheticPreviews = new Map<string, ConversationSyncPreview>();

vi.mock("../../src/target/sync.js", () => ({
  inspectConversationSync: vi.fn(async (conversation: CanonicalConversation) => syntheticPreviews.get(conversation.summary.id)!),
  syncConversations: vi.fn(),
}));
vi.mock("../../src/target/replace.js", () => ({
  inspectConversationReplacement: vi.fn(async (conversation: CanonicalConversation) => ({
    sourceId: conversation.summary.id, status: "replaceable", selectable: true,
    previouslyImported: true, turns: 2, events: 8, attachments: 0, warnings: [],
  })),
  replaceConversations: vi.fn(),
}));

const outputDirectory = join(process.cwd(), "assets");
const temporaryRoots: string[] = [];
afterAll(() => { for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true }); });

async function waitForFrame(tui: { lastFrame(): string | undefined }, expected: string): Promise<string> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const frame = tui.lastFrame() ?? "";
    if (frame.includes(expected)) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const settled = tui.lastFrame() ?? "";
      if (settled.includes(expected)) return settled;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${expected}:\n${tui.lastFrame() ?? "<empty>"}`);
}

function saveFrame(name: string, frame: string): void {
  const sanitized = frame.replace(/Target: [\s\S]*?state(?:v2)?\.sqlite/, "Target: /demo/T3/userdata/statev2.sqlite");
  writeFileSync(join(outputDirectory, `fork-${name}.txt`), `${sanitized.trimEnd()}\n`);
}

describe("synthetic terminal demo capture", () => {
  it("captures the real ImportTui source, status, destination, and review screens", async () => {
    mkdirSync(outputDirectory, { recursive: true });
    const root = await mkdtemp(join(tmpdir(), "t3-import-synthetic-demo-"));
    temporaryRoots.push(root);
    const paths = createTarget(join(root, "t3"), 62);
    vi.stubEnv("T3_IMPORT_DATA_DIR", join(root, "ledger"));
    const workspace = "/demo/OpenCode/project";
    mkdirSync(join(paths.stateDir, "attachments"), { recursive: true });
    const rows: Array<[string, string]> = [
      ["demo-new", "Synthetic new conversation"],
      ["demo-sync", "Synthetic syncable conversation"],
      ["demo-current", "Synthetic current conversation"],
      ["demo-conflict", "Synthetic conflict conversation"],
    ];
    const summaries = rows.map(([id, title]) => ({
      source: "opencode", id, title, workspace, path: `synthetic:${id}`,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", status: "complete", branches: 1,
    } satisfies SourceSummary));
    const conversations = new Map<string, CanonicalConversation>();
    for (const summary of summaries) {
      const conversation = canonicalConversation(workspace);
      conversation.summary = summary;
      conversation.threads[0]!.sourceSessionId = summary.id;
      conversation.threads[0]!.sourceKey = `opencode:${summary.id}`;
      conversation.threads[0]!.title = summary.title;
      conversations.set(summary.id, conversation);
    }
    const status: ConversationSyncPreview["status"][] = ["new", "syncable", "up-to-date", "history-diverged"];
    syntheticPreviews.clear();
    for (const [index, summary] of summaries.entries()) {
      syntheticPreviews.set(summary.id, {
        sourceId: summary.id, status: status[index]!, newTurns: index === 1 ? 2 : 0,
        newCompletedTurns: index === 1 ? 2 : 0, newInterruptedTurns: 0, newFailedTurns: 0,
        ignoredActiveTurns: 0, adoptedTurns: 0, titleChanged: false,
        selectable: index < 2, previouslyImported: index > 0, warnings: [],
      });
    }
    const adapter = sourceAdapter("opencode");
    const discover = vi.spyOn(adapter, "discover").mockResolvedValue(summaries);
    const load = vi.spyOn(adapter, "load").mockImplementation(async (summary) => conversations.get(summary.id)!);
    const tui = render(<ImportTui paths={paths} />);
    try {
      await waitForFrame(tui, "Choose a source");
      tui.stdin.write("j");
      await waitForFrame(tui, "›  Claude Code");
      tui.stdin.write("j");
      const sourceFrame = await waitForFrame(tui, "›  OpenCode");
      expect(sourceFrame).toContain("Choose a source");
      saveFrame("source", sourceFrame);
      tui.stdin.write("\r");
      await waitForFrame(tui, "Choose a workspace");
      tui.stdin.write("\r");
      const statuses = await waitForFrame(tui, "Synthetic conflict conversation");
      expect(statuses).toContain("Synthetic new conversation  new");
      expect(statuses).toContain("Synthetic syncable conversation  2 new turns");
      expect(statuses).toContain("Synthetic current conversation  up to date");
      expect(statuses).toContain("Synthetic conflict conversation  history changed");
      saveFrame("statuses", statuses);
      tui.stdin.write(" ");
      const selected = await waitForFrame(tui, "◉ Synthetic new conversation");
      saveFrame("selected", selected);
      tui.stdin.write("\r");
      const destination = await waitForFrame(tui, "Choose a T3 destination");
      expect(destination).toContain("preserve the source working directory");
      saveFrame("destination", destination);
      tui.stdin.write("\r");
      const review = await waitForFrame(tui, "Review changes");
      expect(review).toContain("T3 must remain closed");
      expect(review).toContain("A verified backup will be created before database changes");
      saveFrame("review", review);
    } finally {
      tui.unmount();
      discover.mockRestore();
      load.mockRestore();
      vi.unstubAllEnvs();
    }
    expect(readFileSync(join(outputDirectory, "fork-review.txt"), "utf8")).toContain("Press Enter to continue");
  });
});
