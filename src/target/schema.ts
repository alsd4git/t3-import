import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { TargetPaths } from "../core/types.js";
import { compatibilityError, safetyError } from "../core/errors.js";
import { isObject, stringValue } from "../core/util.js";
import { v2Profiles, v2Migrations } from "./v2Profiles.js";

export const SUPPORTED_MIGRATIONS = [40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, ...Object.keys(v2Profiles).map(Number)];

export function isV2Database(db: Database.Database): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='orchestration_v2_projection_threads'").get());
}

/** Read the current target version, including when recovering an absent ledger. */
export function targetMigration(db: Database.Database): number {
  const row = db.prepare("SELECT COALESCE(MAX(migration_id), 0) migration FROM effect_sql_migrations").get() as { migration: number };
  if (!SUPPORTED_MIGRATIONS.some((migration) => migration === row.migration)) {
    throw compatibilityError(`Unsupported T3 schema migration ${row.migration}; supported migrations are 40–54 (V1), 62 (T3 0.1.0 V2), 67 (T3 0.1.1/0.1.2 V2), and 69 (T3 0.1.3 V2).`);
  }
  return row.migration;
}

const REQUIRED_COLUMNS: Record<string, string[]> = {
  orchestration_events: ["sequence", "event_id", "aggregate_kind", "stream_id", "stream_version", "event_type", "occurred_at", "actor_kind", "payload_json", "metadata_json"],
  projection_projects: ["project_id", "workspace_root", "deleted_at"],
  projection_state: ["projector", "last_applied_sequence"],
  provider_session_runtime: ["thread_id", "provider_name", "provider_instance_id", "adapter_key", "runtime_mode", "status", "last_seen_at", "resume_cursor_json", "runtime_payload_json"],
};

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function originResponds(origin: string): Promise<boolean> {
  try {
    const response = await fetch(origin, { signal: AbortSignal.timeout(700) });
    return response.status > 0;
  } catch {
    return false;
  }
}

export interface RuntimeState {
  exists: boolean;
  live: boolean;
  pid?: number;
  origin?: string;
  stale: boolean;
}

export async function inspectRuntime(paths: TargetPaths): Promise<RuntimeState> {
  if (!existsSync(paths.runtimeStatePath)) return { exists: false, live: false, stale: false };
  try {
    const value = JSON.parse(readFileSync(paths.runtimeStatePath, "utf8")) as unknown;
    if (!isObject(value)) return { exists: true, live: false, stale: true };
    const pid = typeof value.pid === "number" ? value.pid : undefined;
    const origin = stringValue(value.origin);
    const live = (pid !== undefined && pidAlive(pid)) || (origin !== undefined && await originResponds(origin));
    return { exists: true, live, ...(pid !== undefined ? { pid } : {}), ...(origin ? { origin } : {}), stale: !live };
  } catch {
    return { exists: true, live: false, stale: true };
  }
}

export function runtimeMaintenancePath(paths: TargetPaths): string {
  return join(paths.stateDir, ".t3-import-maintenance.json");
}

export async function assertT3Closed(paths: TargetPaths): Promise<RuntimeState> {
  const marker = runtimeMaintenancePath(paths);
  if (existsSync(marker)) {
    let owner: unknown;
    try { owner = JSON.parse(readFileSync(marker, "utf8")); } catch { /* Refuse unreadable recovery records. */ }
    if (!isObject(owner) || owner.ownerPid !== process.pid) throw safetyError(`T3 maintenance is owned by another command or requires recovery. Review ${marker} before writing.`);
  }
  if (basename(paths.dbPath) === "state.sqlite" && existsSync(join(paths.stateDir, "statev2.sqlite"))) throw safetyError("This home has a V2 database. The legacy state.sqlite is a frozen pre-upgrade copy; select statev2.sqlite instead.");
  const runtime = await inspectRuntime(paths);
  if (runtime.live) {
    const { inspectRuntimeActivity, runtimeActivityText } = await import("./runtimeActivity.js");
    throw safetyError(`T3 is running${runtime.pid ? ` (PID ${runtime.pid})` : ""}. ${runtimeActivityText(inspectRuntimeActivity(paths))} Close T3 before importing, or use --manage-runtime for a verified idle systemd service.`);
  }
  return runtime;
}

export interface SchemaInfo {
  migration: number;
  integrity: string;
  eventCount: number;
  maxSequence: number;
}

export function validateTargetDatabase(db: Database.Database): SchemaInfo {
  const integrity = String(db.pragma("integrity_check", { simple: true }) ?? "unknown");
  if (integrity !== "ok") throw compatibilityError(`T3 database integrity check failed: ${integrity}`);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  const names = new Set(tables.map((entry) => entry.name));
  // New releases can intentionally remove legacy tables. Identify an unsupported
  // migration before checking the older profile's columns and tables.
  if (!names.has("effect_sql_migrations")) throw compatibilityError("Not a compatible T3 database: missing migrations table.");
  const migration = targetMigration(db);
  const profile = v2Profiles[migration];
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    if (profile && table === "projection_state") continue;
    if (!names.has(table)) throw compatibilityError(`Not a compatible T3 database: missing table '${table}'.`);
    const available = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((entry) => entry.name));
    for (const column of columns) if (!available.has(column)) throw compatibilityError(`Unsupported T3 schema: ${table}.${column} is missing.`);
  }
  if (isV2Database(db) !== Boolean(profile)) throw compatibilityError("T3 database schema and migration disagree about the orchestrator version.");
  if (profile) {
    const expected = new Map([...v2Migrations].filter(([id]) => id <= migration));
    const recorded = db.prepare("SELECT migration_id id, name FROM effect_sql_migrations WHERE migration_id >= 55").all() as Array<{ id: number; name: string }>;
    if (recorded.length !== expected.size || recorded.some((row) => expected.get(row.id) !== row.name)) throw compatibilityError(`T3 V2 migration history does not match the pinned ${profile.release} release.`);
    const required = JSON.parse(readFileSync(new URL(`../../vendor/${profile.directory}/schema-columns.json`, import.meta.url), "utf8")) as Record<string, string[]>;
    // Migration 69 deliberately succeeds without FTS5 on older SQLite builds.
    // A present index must retain its shadow tables and maintenance triggers.
    const searchTable = "orchestration_v2_message_search";
    const hasSearch = names.has(searchTable);
    const searchTables = Object.keys(required).filter((table) => table === searchTable || table.startsWith(`${searchTable}_`));
    const searchTriggers = ["insert", "update", "delete"].map((suffix) => `${searchTable}_${suffix}`);
    if (migration >= 69) {
      const triggers = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as Array<{ name: string }>).map((row) => row.name));
      if ((!hasSearch && (searchTables.some((table) => names.has(table)) || searchTriggers.some((trigger) => triggers.has(trigger))))
        || (hasSearch && searchTriggers.some((trigger) => !triggers.has(trigger)))) {
        throw compatibilityError("Incomplete T3 message search index; repair it with T3 before importing.");
      }
    }
    for (const [table, columns] of Object.entries(required)) {
      if (!hasSearch && searchTables.includes(table)) continue;
      const available = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
      for (const column of columns) if (!available.has(column)) throw compatibilityError(`Unsupported T3 V2 schema: ${table}.${column} is missing.`);
    }
  }
  const events = db.prepare("SELECT COUNT(*) count, COALESCE(MAX(sequence), 0) maxSequence FROM orchestration_events").get() as { count: number; maxSequence: number };
  return { migration, integrity, eventCount: events.count, maxSequence: events.maxSequence };
}
