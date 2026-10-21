import type { SourceAdapter, SourceName } from "../core/types.js";
import { ClaudeSource } from "./claude.js";
import { CodexSource } from "./codex.js";
import { OpenCodeSource } from "./opencode.js";

const adapters: Record<SourceName, SourceAdapter> = {
  codex: new CodexSource(),
  claude: new ClaudeSource(),
  opencode: new OpenCodeSource(),
};

export function sourceAdapter(name: SourceName): SourceAdapter {
  return adapters[name];
}

export async function disposeSourceAdapters(): Promise<void> {
  await Promise.all(Object.values(adapters).map((adapter) => adapter.dispose?.()));
}
