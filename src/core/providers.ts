import type { CanonicalThread } from "./types.js";
import { stringValue } from "./util.js";
import { usageError } from "./errors.js";

export const sourceNames = ["codex", "claude", "opencode"] as const;
export type ProviderDriver = "codex" | "claudeAgent" | "opencode";
const drivers = { codex: "codex", claude: "claudeAgent", opencode: "opencode" } as const;
export function sourceDriver(source: string): ProviderDriver {
  if (!Object.hasOwn(drivers, source)) throw usageError(`Unsupported source: ${source}`);
  return drivers[source as typeof sourceNames[number]];
}
export function sourceFromDriver(driver: string): typeof sourceNames[number] | undefined {
  return sourceNames.find((source) => sourceDriver(source) === driver);
}
export function nativeSessionId(thread: CanonicalThread): string | undefined {
  const key = thread.source === "codex" ? "threadId" : thread.source === "claude" ? "resume" : "sessionId";
  return stringValue(thread.resumeCursor?.[key]);
}
