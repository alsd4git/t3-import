import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { TargetPaths } from "../core/types.js";
import { isV2Database, targetMigration } from "./schema.js";
import { openRemoteDelegatedTasks, pendingSubagentDeliveries } from "./v2Work.js";

export interface RuntimeActivity {
  status: "idle" | "busy" | "unknown";
  counts: Record<string, number>;
  warnings: string[];
  fingerprint: string;
}

const EMPTY_FINGERPRINT = createHash("sha256").update("[]").digest("hex");
const V2_REQUIRED_TABLES = [
  "orchestration_v2_projection_runs",
  "orchestration_v2_projection_run_attempts",
  "orchestration_v2_projection_nodes",
  "orchestration_v2_projection_subagents",
  "orchestration_v2_projection_provider_turns",
  "orchestration_v2_projection_provider_sessions",
  "orchestration_v2_projection_provider_threads",
  "orchestration_v2_projection_runtime_requests",
  "orchestration_v2_projection_turn_items",
  "orchestration_v2_thread_launch_workflows",
  "orchestration_v2_effect_outbox",
];

type Row = Record<string, unknown>;

function countRows(db: Database.Database, sql: string, params: unknown[] = []): number {
  const result = db.prepare(sql).get(...params) as { count: number };
  if (!Number.isSafeInteger(result.count) || result.count < 0) throw new Error("Invalid activity count");
  return result.count;
}

function rows(db: Database.Database, sql: string, params: unknown[] = []): Row[] {
  return db.prepare(sql).all(...params) as Row[];
}

function hasTable(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function assertStatuses(db: Database.Database, table: string, column: string, allowed: readonly string[]): void {
  const values = rows(db, `SELECT DISTINCT ${column} value FROM ${table}`);
  for (const row of values) if (typeof row.value !== "string" || !allowed.includes(row.value)) {
    throw new Error(`Unrecognized ${table}.${column} status`);
  }
}

function validateObjectJson(db: Database.Database, table: string, column: string): void {
  const invalid = countRows(db, `SELECT COUNT(*) count FROM ${table} WHERE ${column} IS NULL OR json_valid(${column})=0 OR CASE WHEN json_valid(${column}) THEN json_type(${column})<>'object' ELSE 1 END`);
  if (invalid > 0) throw new Error(`Invalid ${table}.${column} object payload`);
}

function addIds(work: string[], prefix: string, db: Database.Database, table: string, column: string): void {
  for (const row of rows(db, `SELECT ${column} id FROM ${table}`)) work.push(`${prefix}:${row.id}`);
}

function unknownActivity(warning: string): RuntimeActivity {
  return { status: "unknown", counts: {}, warnings: [warning], fingerprint: EMPTY_FINGERPRINT };
}

function setCount(counts: Record<string, number>, name: string, count: number): void {
  counts[name] = count;
}

function inspectV1(db: Database.Database, counts: Record<string, number>, work: string[]): void {
  const required = ["projection_turns", "projection_thread_sessions", "projection_pending_approvals", "provider_session_runtime"];
  for (const table of required) if (!hasTable(db, table)) throw new Error(`Missing required V1 table ${table}`);
  assertStatuses(db, "projection_turns", "state", ["running", "completed", "interrupted", "failed", "error", "pending", "queued"]);
  assertStatuses(db, "projection_thread_sessions", "status", ["idle", "ready", "connecting", "starting", "running", "waiting", "closed", "stopped", "interrupted", "error"]);
  assertStatuses(db, "projection_pending_approvals", "status", ["pending", "waiting", "requested", "resolved", "approved", "denied", "rejected", "cancelled", "expired"]);
  assertStatuses(db, "provider_session_runtime", "status", ["idle", "ready", "connecting", "starting", "running", "waiting", "closed", "stopped", "error"]);
  const activeTurns = rows(db, "SELECT thread_id, turn_id, row_id FROM projection_turns WHERE state IN ('pending','queued','running')");
  const sessions = rows(db, "SELECT thread_id, active_turn_id, status FROM projection_thread_sessions WHERE active_turn_id IS NOT NULL OR status IN ('connecting','starting','running','waiting')");
  const approvals = rows(db, "SELECT request_id FROM projection_pending_approvals WHERE status IN ('pending','waiting','requested')");
  const runtimes = rows(db, "SELECT thread_id, status FROM provider_session_runtime WHERE status IN ('connecting','starting','running','waiting')");
  setCount(counts, "v1_active_turns", activeTurns.length);
  setCount(counts, "v1_active_thread_sessions", sessions.length);
  setCount(counts, "v1_active_provider_runtime", runtimes.length);
  setCount(counts, "v1_pending_approvals", approvals.length);
  for (const row of rows(db, "SELECT thread_id, turn_id, row_id FROM projection_turns")) work.push(`v1-turn:${row.thread_id}:${row.turn_id ?? row.row_id}`);
  for (const row of rows(db, "SELECT request_id FROM projection_pending_approvals")) work.push(`v1-approval:${row.request_id}`);
}

function inspectV2(db: Database.Database, counts: Record<string, number>, work: string[], warnings: string[]): void {
  for (const table of V2_REQUIRED_TABLES) if (!hasTable(db, table)) throw new Error(`Missing required V2 table ${table}`);
  assertStatuses(db, "orchestration_v2_projection_runs", "status", ["preparing", "queued", "starting", "running", "waiting", "completed", "interrupted", "failed", "cancelled", "rolled_back"]);
  assertStatuses(db, "orchestration_v2_projection_run_attempts", "status", ["pending", "running", "completed", "interrupted", "failed", "cancelled", "superseded"]);
  assertStatuses(db, "orchestration_v2_projection_nodes", "status", ["idle", "pending", "running", "waiting", "completed", "interrupted", "failed", "cancelled", "rolled_back"]);
  assertStatuses(db, "orchestration_v2_projection_subagents", "status", ["idle", "pending", "running", "waiting", "completed", "failed", "cancelled", "interrupted"]);
  assertStatuses(db, "orchestration_v2_projection_provider_turns", "status", ["pending", "running", "completed", "interrupted", "failed", "cancelled"]);
  assertStatuses(db, "orchestration_v2_projection_provider_sessions", "status", ["starting", "ready", "running", "waiting", "stopped", "error"]);
  assertStatuses(db, "orchestration_v2_projection_provider_threads", "status", ["not_loaded", "idle", "active", "archived", "closed", "error"]);
  assertStatuses(db, "orchestration_v2_projection_runtime_requests", "status", ["pending", "resolved", "expired", "cancelled"]);
  assertStatuses(db, "orchestration_v2_projection_turn_items", "status", ["idle", "pending", "running", "waiting", "completed", "failed", "cancelled", "interrupted"]);
  assertStatuses(db, "orchestration_v2_thread_launch_workflows", "status", ["pending", "running", "done", "failed"]);
  assertStatuses(db, "orchestration_v2_effect_outbox", "status", ["pending", "running", "succeeded", "failed", "cancelled"]);
  for (const table of [
    "orchestration_v2_projection_runs", "orchestration_v2_projection_run_attempts", "orchestration_v2_projection_nodes",
    "orchestration_v2_projection_subagents", "orchestration_v2_projection_provider_turns", "orchestration_v2_projection_provider_sessions",
    "orchestration_v2_projection_provider_threads", "orchestration_v2_projection_runtime_requests", "orchestration_v2_projection_turn_items",
    "orchestration_v2_effect_outbox",
  ]) validateObjectJson(db, table, "payload_json");
  const activeRuns = rows(db, "SELECT run_id FROM orchestration_v2_projection_runs WHERE status IN ('preparing','queued','starting','running','waiting')");
  const activeAttempts = rows(db, "SELECT attempt_id FROM orchestration_v2_projection_run_attempts WHERE status IN ('pending','running')");
  const activeNodes = rows(db, "SELECT node_id FROM orchestration_v2_projection_nodes WHERE status IN ('pending','running','waiting')");
  const activeSubagents = rows(db, "SELECT subagent_id FROM orchestration_v2_projection_subagents WHERE status IN ('pending','running','waiting')");
  const activeTurns = rows(db, "SELECT provider_turn_id FROM orchestration_v2_projection_provider_turns WHERE status IN ('pending','running')");
  const activeSessions = rows(db, "SELECT provider_session_id FROM orchestration_v2_projection_provider_sessions WHERE status IN ('starting','running','waiting')");
  const requests = rows(db, "SELECT runtime_request_id FROM orchestration_v2_projection_runtime_requests WHERE status='pending'");
  const launchWorkflows = rows(db, "SELECT command_id FROM orchestration_v2_thread_launch_workflows WHERE status IN ('pending','running')");
  const activeItems = rows(db, "SELECT turn_item_id FROM orchestration_v2_projection_turn_items WHERE status IN ('pending','running','waiting') AND type IN ('command_execution','background_command','monitor','background_task','subagent','link_request')");
  const badPendingTasks = countRows(db, `SELECT COUNT(*) count FROM orchestration_v2_projection_provider_threads WHERE CASE WHEN json_type(payload_json,'$.pendingBackgroundTasks') IS NULL THEN 0 WHEN json_type(payload_json,'$.pendingBackgroundTasks')<>'array' THEN 1 ELSE EXISTS (SELECT 1 FROM json_each(payload_json,'$.pendingBackgroundTasks') task WHERE json_type(task.value)<>'object' OR json_type(task.value,'$.taskId') IS NOT 'text' OR length(json_extract(task.value,'$.taskId'))=0) END`);
  if (badPendingTasks > 0) throw new Error("Invalid provider-thread pending background tasks");
  const backgroundTasks = rows(db, `SELECT provider_thread_id, json_extract(task.value,'$.taskId') task_id FROM orchestration_v2_projection_provider_threads, json_each(orchestration_v2_projection_provider_threads.payload_json,'$.pendingBackgroundTasks') task`);
  const pendingBackgroundTasks = backgroundTasks.length;
  const deliveries = pendingSubagentDeliveries(db);
  setCount(counts, "v2_pending_subagent_deliveries", deliveries.length);
  for (const task of deliveries) work.push(`v2-delivery:${task.threadId}:${task.taskId}`);
  const remoteTasks = openRemoteDelegatedTasks(db);
  setCount(counts, "v2_open_remote_tasks", remoteTasks.length);
  for (const task of remoteTasks) work.push(`v2-remote:${task.threadId}:${task.taskId}`);
  for (const task of backgroundTasks) work.push(`v2-background:${task.provider_thread_id}:${task.task_id}`);
  setCount(counts, "v2_nonterminal_runs", activeRuns.length);
  setCount(counts, "v2_nonterminal_attempts", activeAttempts.length);
  setCount(counts, "v2_active_nodes", activeNodes.length);
  setCount(counts, "v2_active_subagents", activeSubagents.length);
  setCount(counts, "v2_active_provider_turns", activeTurns.length);
  setCount(counts, "v2_active_provider_sessions", activeSessions.length);
  setCount(counts, "v2_pending_runtime_requests", requests.length);
  setCount(counts, "v2_active_turn_items", activeItems.length);
  setCount(counts, "v2_pending_background_tasks", pendingBackgroundTasks);
  setCount(counts, "v2_active_thread_launch_workflows", launchWorkflows.length);
  addIds(work, "v2-run", db, "orchestration_v2_projection_runs", "run_id");
  addIds(work, "v2-attempt", db, "orchestration_v2_projection_run_attempts", "attempt_id");
  addIds(work, "v2-node", db, "orchestration_v2_projection_nodes", "node_id");
  addIds(work, "v2-subagent", db, "orchestration_v2_projection_subagents", "subagent_id");
  addIds(work, "v2-provider-turn", db, "orchestration_v2_projection_provider_turns", "provider_turn_id");
  addIds(work, "v2-runtime-request", db, "orchestration_v2_projection_runtime_requests", "runtime_request_id");
  addIds(work, "v2-launch", db, "orchestration_v2_thread_launch_workflows", "command_id");
  addIds(work, "v2-item", db, "orchestration_v2_projection_turn_items", "turn_item_id");

  const now = new Date().toISOString();
  if (hasTable(db, "scheduled_tasks")) {
    assertStatuses(db, "scheduled_tasks", "last_run_status", ["never", "running", "succeeded", "failed"]);
    const running = countRows(db, "SELECT COUNT(*) count FROM scheduled_tasks WHERE last_run_status='running'");
    const due = countRows(db, "SELECT COUNT(*) count FROM scheduled_tasks WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=? AND COALESCE(last_run_status,'')<>'running'", [now]);
    const future = rows(db, "SELECT task_id FROM scheduled_tasks WHERE enabled=1 AND next_run_at>? AND COALESCE(last_run_status,'')<>'running'", [now]);
    setCount(counts, "scheduler_running_tasks", running);
    setCount(counts, "scheduler_due_tasks", due);
    setCount(counts, "scheduler_future_tasks", future.length);
    if (future.length > 0) warnings.push(`${future.length} enabled scheduled task(s) are due in the future.`);
    for (const row of rows(db, "SELECT task_id FROM scheduled_tasks WHERE last_run_status='running'")) work.push(`scheduler-running:${row.task_id}`);
    for (const row of rows(db, "SELECT task_id FROM scheduled_tasks WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=?", [now])) work.push(`scheduler-due:${row.task_id}`);
  }
  if (hasTable(db, "scheduled_task_webhook_pending")) {
    assertStatuses(db, "scheduled_task_webhook_pending", "state", ["pending", "dispatching", "running", "completed", "failed"]);
    const pending = rows(db, "SELECT delivery_id, task_id FROM scheduled_task_webhook_pending WHERE state IN ('pending','dispatching','running')");
    setCount(counts, "pending_webhook_deliveries", pending.length);
    for (const row of pending) work.push(`webhook:${row.delivery_id}:${row.task_id}`);
  }
  const effects = rows(db, "SELECT effect_id FROM orchestration_v2_effect_outbox WHERE status IN ('pending','running')");
  setCount(counts, "pending_effects", effects.length);
  addIds(work, "v2-effect", db, "orchestration_v2_effect_outbox", "effect_id");
}

/** Read a single SQLite snapshot of persisted activity. This function never contacts or mutates T3. */
export function inspectRuntimeActivity(paths: TargetPaths): RuntimeActivity {
  if (!existsSync(paths.dbPath)) return unknownActivity("T3 database does not exist.");
  let db: Database.Database | undefined;
  try {
    db = new Database(paths.dbPath, { readonly: true, fileMustExist: true });
    db.pragma("query_only = ON");
    const result = db.transaction(() => {
      const counts: Record<string, number> = {};
      const warnings: string[] = [];
      const work: string[] = [];
      const migration = targetMigration(db!);
      const v2 = isV2Database(db!);
      if (v2 !== (migration >= 55)) throw new Error("Database migration and V2 schema disagree");
      if (v2) inspectV2(db!, counts, work, warnings);
      else inspectV1(db!, counts, work);
      const busy = Object.entries(counts).some(([key, count]) => !key.includes("future") && count > 0);
      const fingerprint = createHash("sha256").update(JSON.stringify(work.sort())).digest("hex");
      return { status: busy ? "busy" as const : "idle" as const, counts, warnings, fingerprint };
    }).deferred();
    return result;
  } catch (error) {
    return unknownActivity(`Unable to determine runtime activity: ${error instanceof Error ? error.message : "invalid database state"}`);
  } finally {
    db?.close();
  }
}

export function runtimeActivityText(activity: RuntimeActivity): string {
  if (activity.status === "unknown") return `Activity unknown: ${activity.warnings.join("; ") || "inspection unavailable"}`;
  const active = Object.entries(activity.counts).filter(([name, count]) => count > 0 && name !== "scheduler_future_tasks").map(([name, count]) => `${name}: ${count}`);
  return activity.status === "busy" ? `T3 has unfinished work (${active.join(", ")}).` : "T3 is idle in the persisted activity snapshot (no unfinished work).";
}
