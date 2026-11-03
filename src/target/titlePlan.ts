import { randomUUID } from "node:crypto";
import type { TargetPaths } from "../core/types.js";
import { compatibilityError, usageError } from "../core/errors.js";
import { inspectLinkedThreads, type InspectLinkedThreadsOptions } from "./reconciliation.js";

/** Prepare a native MCP rename; never modify the target or contact its server. */
export async function prepareTitlePlan(
  paths: TargetPaths,
  threadId: string,
  title: string,
  options: InspectLinkedThreadsOptions = {},
) {
  if (!threadId.trim() || !title.trim()) throw usageError("Thread ID and title must not be empty.");
  const report = await inspectLinkedThreads(paths, options);
  if (report.migration < 62) throw compatibilityError("Native title plans require T3 V2 and its t3_thread_update MCP tool.");
  const thread = report.threads.find((item) => item.threadId === threadId);
  if (!thread) throw usageError("Thread not found in the selected T3 database and scope. Archived and subagent threads require their explicit include flags.");
  const proposedTitle = title.trim();
  const changed = proposedTitle !== thread.title;
  return {
    schemaVersion: 1 as const,
    status: changed ? "planned" as const : "unchanged" as const,
    target: report.target,
    migration: report.migration,
    generatedAt: report.generatedAt,
    provisional: report.provisional,
    expected: thread,
    proposedTitle,
    call: changed ? {
      tool: "t3_thread_update" as const,
      arguments: { action: "rename" as const, threadId, title: proposedTitle, clientRequestId: randomUUID() },
    } : null,
  };
}
