import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTarget } from "./helpers.js";
import { inspectRuntimeActivity, runtimeActivityText } from "../src/target/runtimeActivity.js";

const roots: string[] = [];
function target(migration: number) {
  const root = mkdtempSync(join(tmpdir(), "t3-runtime-activity-"));
  roots.push(root);
  return createTarget(root, migration);
}
function mutate(dbPath: string, operation: (db: Database.Database) => void) {
  const db = new Database(dbPath);
  try { operation(db); } finally { db.close(); }
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("inspectRuntimeActivity", () => {
  it.each([40, 67, 69, 72, 76])("reports an idle V%i fixture", (migration) => {
    const paths = target(migration);
    const result = inspectRuntimeActivity(paths);
    expect(result.status).toBe("idle");
    expect(result.warnings).toEqual([]);
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("counts active V1 turns, sessions, provider runtime, and approvals", () => {
    const paths = target(40);
    mutate(paths.dbPath, (db) => {
      db.prepare("INSERT INTO projection_turns (thread_id,turn_id,state,requested_at,checkpoint_files_json) VALUES ('t','turn-1','running','2026-01-01T00:00:00Z','[]')").run();
      db.prepare("INSERT INTO projection_thread_sessions (thread_id,status,active_turn_id,updated_at) VALUES ('t','running','turn-1','2026-01-01T00:00:00Z')").run();
      db.prepare("INSERT INTO projection_pending_approvals (request_id,thread_id,status,created_at) VALUES ('approval-1','t','pending','2026-01-01T00:00:00Z')").run();
      db.prepare("INSERT INTO provider_session_runtime (thread_id,provider_name,adapter_key,status,last_seen_at) VALUES ('t','codex','codex','starting','2026-01-01T00:00:00Z')").run();
    });
    const result = inspectRuntimeActivity(paths);
    expect(result.status).toBe("busy");
    expect(result.counts).toMatchObject({ v1_active_turns: 1, v1_active_thread_sessions: 1, v1_active_provider_runtime: 1, v1_pending_approvals: 1 });
  });

  it("does not mistake historical stopped V1 bindings for active work", () => {
    const paths = target(40);
    mutate(paths.dbPath, (db) => {
      db.prepare("INSERT INTO projection_thread_sessions (thread_id,status,updated_at) VALUES ('t','closed','2026-01-01T00:00:00Z')").run();
      db.prepare("INSERT INTO provider_session_runtime (thread_id,provider_name,adapter_key,status,last_seen_at) VALUES ('t','codex','codex','stopped','2026-01-01T00:00:00Z')").run();
    });
    expect(inspectRuntimeActivity(paths).status).toBe("idle");
  });

  it("counts V2 nonterminal runs and pending runtime/background work", () => {
    const paths = target(67);
    mutate(paths.dbPath, (db) => {
      db.prepare("INSERT INTO orchestration_v2_projection_runs (run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES ('run-1','t',1,'codex','running','2026-01-01T00:00:00Z','{}')").run();
      db.prepare("INSERT INTO orchestration_v2_projection_runtime_requests (runtime_request_id,thread_id,node_id,kind,status,created_at,payload_json) VALUES ('request-1','t','node-1','approval','pending','2026-01-01T00:00:00Z','{}')").run();
      db.prepare("INSERT INTO orchestration_v2_projection_provider_threads (provider_thread_id,provider,status,updated_at,payload_json) VALUES ('pt-1','codex','active','2026-01-01T00:00:00Z',?)").run(JSON.stringify({ pendingBackgroundTasks: [{ taskId: "bg-1", kind: "command" }] }));
    });
    const result = inspectRuntimeActivity(paths);
    expect(result.status).toBe("busy");
    expect(result.counts).toMatchObject({ v2_nonterminal_runs: 1, v2_pending_runtime_requests: 1, v2_pending_background_tasks: 1 });
  });

  it("fails closed for unsupported schemas and corrupt activity payloads", () => {
    const unsupported = target(999);
    expect(inspectRuntimeActivity(unsupported).status).toBe("unknown");
    const incomplete = target(67);
    mutate(incomplete.dbPath, (db) => db.exec("DROP TABLE orchestration_v2_projection_nodes"));
    expect(inspectRuntimeActivity(incomplete).status).toBe("unknown");
    const corrupt = target(67);
    mutate(corrupt.dbPath, (db) => db.prepare("INSERT INTO orchestration_v2_projection_provider_threads (provider_thread_id,provider,status,updated_at,payload_json) VALUES ('pt','codex','idle','2026-01-01T00:00:00Z','{')").run());
    expect(inspectRuntimeActivity(corrupt).status).toBe("unknown");
    const primitive = target(67);
    mutate(primitive.dbPath, (db) => db.prepare("INSERT INTO orchestration_v2_projection_runs (run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES ('run','t',1,'codex','completed','2026-01-01T00:00:00Z','[]')").run());
    expect(inspectRuntimeActivity(primitive).status).toBe("unknown");
  });

  it("keeps future schedules idle, while due schedules and webhooks are busy", () => {
    const paths = target(67);
    const task = (id: string, when: string, status = "never") => [id, "fixture", "prompt", 1, "{}", "project", "{}", "{}", "full-access", "default", "user", "manual", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", when, status, 0];
    mutate(paths.dbPath, (db) => {
      db.prepare("INSERT INTO scheduled_tasks (task_id,title,prompt,enabled,schedule_json,project_id,workspace_strategy_json,model_selection_json,runtime_mode,interaction_mode,created_by,creation_source,created_at,updated_at,next_run_at,last_run_status,run_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(...task("future", "2999-01-01T00:00:00.000Z"));
    });
    expect(inspectRuntimeActivity(paths)).toMatchObject({ status: "idle", counts: { scheduler_future_tasks: 1 }, warnings: [expect.stringContaining("future")] });
    mutate(paths.dbPath, (db) => {
      db.prepare("UPDATE scheduled_tasks SET next_run_at='2000-01-01T00:00:00.000Z' WHERE task_id='future'").run();
      db.prepare("INSERT INTO scheduled_task_webhook_pending (delivery_id,task_id,coalesce_key,due_at,task_json,request_json,delivery_ids_json) VALUES ('delivery-1','future','key',0,'{}','{}','[]')").run();
    });
    expect(inspectRuntimeActivity(paths)).toMatchObject({ status: "busy", counts: { scheduler_due_tasks: 1, pending_webhook_deliveries: 1 } });
  });

  it("changes the fingerprint when a completed run appears during shutdown", () => {
    const paths = target(67);
    const before = inspectRuntimeActivity(paths).fingerprint;
    mutate(paths.dbPath, (db) => db.prepare("INSERT INTO orchestration_v2_projection_runs (run_id,thread_id,ordinal,provider,status,requested_at,completed_at,payload_json) VALUES ('new-run','t',1,'codex','completed','2026-01-01T00:00:00Z','2026-01-01T00:01:00Z','{}')").run());
    expect(inspectRuntimeActivity(paths).fingerprint).not.toBe(before);
  });

  it("keeps the fingerprint stable when a provider session disconnects", () => {
    const paths = target(67);
    mutate(paths.dbPath, (db) => db.prepare("INSERT INTO orchestration_v2_projection_provider_sessions (provider_session_id,provider,status,updated_at,payload_json) VALUES ('session-1','codex','ready','2026-01-01T00:00:00Z','{}')").run());
    const before = inspectRuntimeActivity(paths).fingerprint;
    mutate(paths.dbPath, (db) => db.prepare("UPDATE orchestration_v2_projection_provider_sessions SET status='stopped',updated_at='2026-01-01T00:01:00Z' WHERE provider_session_id='session-1'").run());
    expect(inspectRuntimeActivity(paths).fingerprint).toBe(before);
  });

  it("does not report idle for unknown statuses and excludes future schedules from the busy summary", () => {
    const paths = target(67);
    mutate(paths.dbPath, (db) => db.prepare("INSERT INTO orchestration_v2_projection_runs (run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES ('run-1','t',1,'codex','future_state','2026-01-01T00:00:00Z','{}')").run());
    expect(inspectRuntimeActivity(paths).status).toBe("unknown");

    const scheduled = target(67);
    mutate(scheduled.dbPath, (db) => {
      db.prepare("INSERT INTO scheduled_tasks (task_id,title,prompt,enabled,schedule_json,project_id,workspace_strategy_json,model_selection_json,runtime_mode,interaction_mode,created_by,creation_source,created_at,updated_at,next_run_at,last_run_status,run_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("future", "fixture", "prompt", 1, "{}", "project", "{}", "{}", "full-access", "default", "user", "manual", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "2999-01-01T00:00:00Z", "never", 0);
      db.prepare("INSERT INTO orchestration_v2_projection_runs (run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES ('busy-run','t',1,'codex','running','2026-01-01T00:00:00Z','{}')").run();
    });
    expect(runtimeActivityText(inspectRuntimeActivity(scheduled))).not.toContain("scheduler_future_tasks");
  });
});
