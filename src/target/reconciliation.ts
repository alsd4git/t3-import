import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import type { SourceName, TargetPaths } from "../core/types.js";
import { isObject, stringValue } from "../core/util.js";
import { sourceDriver, sourceFromDriver, sourceNames } from "../core/providers.js";
import { compatibilityError, safetyError } from "../core/errors.js";
import { inspectRuntime, isV2Database, validateTargetDatabase } from "./schema.js";

type MappingStatus = "strong" | "weak" | "historical" | "ambiguous" | "unlinked";
type ThreadOrigin = "imported" | "native" | "unknown";

export interface LinkedProviderBinding {
  source: SourceName;
  driver: string;
  nativeId: string | null;
  strength: "strong" | "weak" | "none";
  providerInstanceId: string | null;
  status: string | null;
  providerThreadId?: string;
}

export interface LinkedThreadEvidence {
  threadId: string;
  title: string;
  projectId: string | null;
  projectTitle: string | null;
  projectRoot: string | null;
  worktreePath: string | null;
  effectiveCwd: string | null;
  archived: boolean;
  subagent: boolean;
  lineage: { parentThreadId: string | null; relationshipToParent: string | null; rootThreadId: string | null };
  origin: ThreadOrigin;
  bindings: LinkedProviderBinding[];
  historicalBindings: LinkedProviderBinding[];
  migration: { status: "legacy-only" | "continued" | "unverified"; handoffIds: string[] } | null;
  mapping: MappingStatus;
  ambiguity: string[];
  evidence: string[];
}

export interface LinkedThreadsReport {
  schemaVersion: 1;
  target: string;
  migration: number;
  generatedAt: string;
  provisional: boolean;
  runtime: { live: boolean; pid?: number; origin?: string };
  transcriptEquality: "not_assessed";
  threads: LinkedThreadEvidence[];
}

export interface InspectLinkedThreadsOptions {
  source?: SourceName;
  includeSubagents?: boolean;
  includeArchived?: boolean;
}

interface DbThread {
  threadId: string;
  title: string;
  projectId: string | null;
  projectTitle: string | null;
  projectRoot: string | null;
  worktreePath: string | null;
  archivedAt: string | null;
  deletedAt: string | null;
  payload: string | null;
}

function parseObject(value: string | null | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isObject(parsed) ? parsed : undefined;
  } catch { return undefined; }
}

function v2ThreadRows(db: Database.Database): DbThread[] {
  return db.prepare(`SELECT t.thread_id threadId, t.title, t.project_id projectId,
      p.title projectTitle, p.workspace_root projectRoot, json_extract(t.payload_json,'$.worktreePath') worktreePath,
      t.archived_at archivedAt, t.deleted_at deletedAt, t.payload_json payload
    FROM orchestration_v2_projection_threads t
    LEFT JOIN projection_projects p ON p.project_id=t.project_id
    ORDER BY t.created_at, t.thread_id`).all() as DbThread[];
}

function v1ThreadRows(db: Database.Database): DbThread[] {
  const projected = db.prepare(`SELECT t.thread_id threadId, t.title, t.project_id projectId,
      p.title projectTitle, p.workspace_root projectRoot, t.worktree_path worktreePath,
      t.archived_at archivedAt, t.deleted_at deletedAt, NULL payload
    FROM projection_threads t
    LEFT JOIN projection_projects p ON p.project_id=t.project_id
    ORDER BY t.created_at, t.thread_id`).all() as DbThread[];
  const projects = new Map<string, { title: string; root: string }>();
  for (const row of db.prepare("SELECT project_id id,title,workspace_root root FROM projection_projects").all() as Array<{ id: string; title: string; root: string }>) projects.set(row.id, { title: row.title, root: row.root });
  for (const row of db.prepare("SELECT stream_id id,event_type type,payload_json payload FROM orchestration_events WHERE aggregate_kind='project' ORDER BY sequence").all() as Array<{ id: string; type: string; payload: string }>) {
    const payload = parseObject(row.payload);
    if (!payload) continue;
    const title = stringValue(payload.title);
    const root = stringValue(payload.workspaceRoot);
    if (title && root && row.type !== "project.deleted") projects.set(row.id, { title, root });
    if (row.type === "project.deleted") projects.delete(row.id);
  }
  const threads = new Map<string, DbThread>();
  for (const row of db.prepare("SELECT stream_id id,event_type type,payload_json payload FROM orchestration_events WHERE aggregate_kind='thread' ORDER BY sequence").all() as Array<{ id: string; type: string; payload: string }>) {
    const payload = parseObject(row.payload);
    if (!payload) continue;
    const current = threads.get(row.id);
    if (row.type === "thread.created") {
      const projectId = stringValue(payload.projectId) ?? null;
      const project = projectId ? projects.get(projectId) : undefined;
      threads.set(row.id, {
        threadId: row.id, title: stringValue(payload.title) ?? row.id, projectId,
        projectTitle: project?.title ?? null, projectRoot: project?.root ?? null,
        worktreePath: stringValue(payload.worktreePath) ?? null,
        archivedAt: stringValue(payload.archivedAt) ?? null, deletedAt: stringValue(payload.deletedAt) ?? null, payload: null,
      });
    } else if (current && (row.type === "thread.meta-updated" || row.type === "thread.deleted")) {
      const projectId = stringValue(payload.projectId) ?? current.projectId;
      const project = projectId ? projects.get(projectId) : undefined;
      threads.set(row.id, {
        ...current, title: stringValue(payload.title) ?? current.title, projectId,
        projectTitle: project?.title ?? current.projectTitle, projectRoot: project?.root ?? current.projectRoot,
        worktreePath: typeof payload.worktreePath === "string" ? payload.worktreePath : current.worktreePath,
        archivedAt: typeof payload.archivedAt === "string" ? payload.archivedAt : current.archivedAt,
        deletedAt: row.type === "thread.deleted" ? stringValue(payload.deletedAt) ?? "deleted" : current.deletedAt,
      });
    }
  }
  for (const row of projected) if (!threads.has(row.threadId)) threads.set(row.threadId, row);
  return [...threads.values()].sort((a, b) => a.threadId.localeCompare(b.threadId));
}

function v2Bindings(db: Database.Database, threadId: string, thread: Record<string, unknown>): LinkedProviderBinding[] {
  const rows = db.prepare("SELECT provider_thread_id providerThreadId, thread_id threadId, driver, provider_instance_id providerInstanceId, payload_json payload FROM orchestration_v2_projection_provider_threads WHERE thread_id=?").all(threadId) as Array<{ providerThreadId: string; threadId: string | null; driver: string | null; providerInstanceId: string | null; payload: string }>;
  const appThreadId = stringValue(thread.id) ?? threadId;
  const candidates = rows.flatMap((row) => {
    const payload = parseObject(row.payload);
    if (!payload || (stringValue(payload.appThreadId) ?? row.threadId) !== appThreadId) return [];
    const ref = isObject(payload.nativeThreadRef) ? payload.nativeThreadRef : undefined;
    const driver = stringValue(ref?.driver) ?? row.driver ?? stringValue(payload.driver);
    const source = driver ? sourceFromDriver(driver) : undefined;
    if (!driver || !source) return [];
    const strength: LinkedProviderBinding["strength"] = ref?.strength === "strong" || ref?.strength === "weak" ? ref.strength : "none";
    return [{
      source, driver, nativeId: stringValue(ref?.nativeId) ?? null, strength,
      providerInstanceId: stringValue(payload.providerInstanceId) ?? row.providerInstanceId,
      status: stringValue(payload.status) ?? null,
      providerThreadId: stringValue(payload.id) ?? row.providerThreadId,
    }];
  });
  const activeId = stringValue(thread.activeProviderThreadId);
  const selected = activeId ? candidates.filter((item) => item.providerThreadId === activeId) : candidates;
  return selected;
}

function migrationEvidence(db: Database.Database, threadId: string, thread: Record<string, unknown> | undefined,
  bindings: LinkedProviderBinding[], historical: LinkedProviderBinding[]): LinkedThreadEvidence["migration"] {
  if (!historical.length || thread?.historyOrigin !== "v1_import") return null;
  const current = bindings.filter((binding) => binding.nativeId);
  if (!current.length) return { status: "legacy-only", handoffIds: [] };
  const rows = db.prepare("SELECT payload_json payload FROM orchestration_v2_projection_context_handoffs WHERE thread_id=?").all(threadId) as Array<{ payload: string }>;
  const handoffIds = rows.flatMap((row) => {
    const handoff = parseObject(row.payload);
    if (!handoff || handoff.threadId !== threadId || handoff.strategy !== "manual_context" || handoff.status !== "ready") return [];
    const target = current.find((binding) => binding.providerThreadId === handoff.toProviderThreadId);
    const covered = isObject(handoff.coveredRunOrdinals) ? handoff.coveredRunOrdinals : undefined;
    // The cutover's first-run handoff establishes continuity, not equal transcripts.
    if (!target || covered?.from !== 1 || covered?.to !== 1) return [];
    return stringValue(handoff.id) ? [String(handoff.id)] : [];
  });
  return { status: handoffIds.length ? "continued" : "unverified", handoffIds };
}

function v1Binding(db: Database.Database, threadId: string): { binding?: LinkedProviderBinding; imported: boolean; evidence: string[] } {
  const row = db.prepare(`SELECT adapter_key adapterKey, provider_instance_id providerInstanceId,
      status, resume_cursor_json cursor, runtime_payload_json runtimePayload
    FROM provider_session_runtime WHERE thread_id=?`).get(threadId) as { adapterKey: string; providerInstanceId: string | null; status: string; cursor: string | null; runtimePayload: string | null } | undefined;
  if (!row) return { imported: false, evidence: [] };
  const source = sourceFromDriver(row.adapterKey);
  if (!source) return { imported: false, evidence: ["V1 provider runtime uses an unrecognized adapter key."] };
  const cursor = parseObject(row.cursor);
  const runtime = parseObject(row.runtimePayload);
  const nativeId = source === "claude" ? stringValue(cursor?.resume)
    : source === "opencode" ? stringValue(cursor?.sessionId)
      : stringValue(cursor?.threadId);
  const imported = stringValue(runtime?.lastRuntimeEvent)?.startsWith("t3-import.") ?? false;
  return {
    binding: { source, driver: row.adapterKey, nativeId: nativeId ?? null, strength: nativeId ? "strong" : "none", providerInstanceId: row.providerInstanceId, status: row.status },
    imported,
    evidence: ["Legacy provider_session_runtime binding", ...(nativeId ? ["Native ID read from the provider resume cursor"] : ["Resume cursor does not contain a recognized native ID"]), ...(imported ? ["Importer runtime marker identifies a prior import"] : [])],
  };
}

interface T3ImportMetadata { source: SourceName; sourceSessionId: string }

function readV2ImportMetadata(db: Database.Database, threadId: string): T3ImportMetadata | undefined {
  const rows = db.prepare("SELECT metadata_json metadata FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=? AND event_type='thread.created'").all(threadId) as Array<{ metadata: string }>;
  for (const row of rows) {
    const metadata = parseObject(row.metadata);
    const value = isObject(metadata?.t3Import) ? metadata.t3Import : undefined;
    const source = typeof value?.source === "string" && sourceNames.includes(value.source as SourceName) ? value.source as SourceName : undefined;
    const sourceSessionId = stringValue(value?.sourceSessionId);
    if (value?.schemaVersion === 1 && value.canonical === true && source && sourceSessionId) return { source, sourceSessionId };
  }
  return undefined;
}

function originOf(thread: Record<string, unknown> | undefined, importedMetadata: T3ImportMetadata | undefined, v1Imported = false): ThreadOrigin {
  if (importedMetadata || v1Imported) return "imported";
  if (thread?.historyOrigin === "v1_import") return "unknown";
  if (thread?.historyOrigin === "native" || stringValue(thread?.creationSource)) return "native";
  return "unknown";
}

function buildRows(db: Database.Database, v2: boolean, options: InspectLinkedThreadsOptions): LinkedThreadEvidence[] {
  const records = v2 ? v2ThreadRows(db) : v1ThreadRows(db);
  const out = records.flatMap((row): Array<LinkedThreadEvidence & { includeInReport: boolean }> => {
    if (row.deletedAt) return [];
    const projected = parseObject(row.payload);
    const archived = Boolean(row.archivedAt) || Boolean(projected?.archivedAt);
    const lineage = isObject(projected?.lineage) ? projected.lineage : {};
    const subagent = lineage.relationshipToParent === "subagent";
    const bindings = v2 ? v2Bindings(db, row.threadId, projected ?? {}) : [];
    const legacy = v1Binding(db, row.threadId);
    const historicalBindings = v2 && legacy.binding?.nativeId ? [legacy.binding] : [];
    if (!v2 && legacy.binding) bindings.push(legacy.binding);
    const importMetadata = v2 ? readV2ImportMetadata(db, row.threadId) : undefined;
    if (importMetadata && !bindings.some((binding) => binding.source === importMetadata.source && binding.nativeId === importMetadata.sourceSessionId)) {
      bindings.push({ source: importMetadata.source, driver: sourceDriver(importMetadata.source), nativeId: importMetadata.sourceSessionId, strength: "strong", providerInstanceId: stringValue(projected?.providerInstanceId) ?? null, status: "imported" });
    }
    const includeInReport = (!archived || Boolean(options.includeArchived))
      && (!subagent || Boolean(options.includeSubagents))
      && (!options.source || [...bindings, ...historicalBindings].some((binding) => binding.source === options.source));
    const strong = bindings.filter((binding) => binding.strength === "strong" && binding.nativeId);
    const localAmbiguity = new Set(strong.map((binding) => `${binding.source}\u0000${binding.nativeId}`)).size > 1;
    const mapping: MappingStatus = localAmbiguity ? "ambiguous" : strong.length ? "strong" : bindings.some((binding) => binding.strength === "weak") ? "weak" : historicalBindings.length ? "historical" : "unlinked";
    const provider = strong[0] ?? bindings[0];
    const effectiveCwd = row.worktreePath ?? row.projectRoot;
    const migration = v2 ? migrationEvidence(db, row.threadId, projected, bindings, historicalBindings) : null;
    const importMismatch = Boolean(importMetadata && bindings.some((binding) => binding.strength === "strong" && binding.nativeId && (binding.source !== importMetadata.source || binding.nativeId !== importMetadata.sourceSessionId)));
    const evidence = v2
      ? [projected?.historyOrigin === "v1_import" ? "V2 app-thread historyOrigin is v1_import" : "V2 app-thread projection inspected", ...(provider?.providerThreadId ? ["Provider-thread nativeThreadRef inspected"] : ["No native provider-thread reference found"]), ...(historicalBindings.length ? ["Retained V1 resume cursor proves historical provider identity, not the current V2 session"] : []), ...(migration?.status === "continued" ? ["First-run manual_context handoff links legacy app history to the current V2 provider thread"] : []), ...(importMetadata ? ["Canonical thread.created metadata carries the t3Import source identity"] : [])]
      : legacy?.evidence ?? ["V1 projected thread inspected"];
    const ambiguity = [
      ...(localAmbiguity ? ["This T3 thread has multiple distinct strong native-provider bindings."] : []),
      ...(importMismatch ? ["The canonical t3Import source identity disagrees with a strong provider native reference."] : []),
    ];
    return [{
      threadId: row.threadId, title: row.title, projectId: row.projectId, projectTitle: row.projectTitle, projectRoot: row.projectRoot,
      worktreePath: row.worktreePath, effectiveCwd, archived, subagent,
      lineage: { parentThreadId: stringValue(lineage.parentThreadId) ?? null, relationshipToParent: stringValue(lineage.relationshipToParent) ?? null, rootThreadId: stringValue(lineage.rootThreadId) ?? null },
      origin: originOf(projected, importMetadata, legacy.imported), bindings, historicalBindings, migration,
      mapping: localAmbiguity || importMismatch ? "ambiguous" : mapping,
      ambiguity, evidence, includeInReport,
    }];
  });
  const byNative = new Map<string, LinkedThreadEvidence[]>();
  for (const thread of out) for (const binding of [...thread.bindings, ...thread.historicalBindings]) {
    if (binding.strength !== "strong" || !binding.nativeId) continue;
    const key = `${binding.source}\u0000${binding.nativeId}`;
    byNative.set(key, [...(byNative.get(key) ?? []), thread]);
  }
  const ambiguous = new Map<string, string[]>();
  for (const [key, matches] of byNative) {
    const threadIds = [...new Set(matches.map((thread) => thread.threadId))];
    if (threadIds.length > 1) ambiguous.set(key, threadIds);
  }
  return out.map((thread) => {
    const keys = [...thread.bindings, ...thread.historicalBindings].filter((binding) => binding.strength === "strong" && binding.nativeId)
      .map((binding) => `${binding.source}\u0000${binding.nativeId}`);
    const duplicateTargets = keys.flatMap((key) => ambiguous.get(key) ?? []);
    if (!duplicateTargets.length) return thread;
    const threadIds = [...new Set(duplicateTargets)].sort();
    return { ...thread, mapping: "ambiguous" as MappingStatus, ambiguity: [...thread.ambiguity, `Native source binding also appears on T3 thread(s): ${threadIds.filter((id) => id !== thread.threadId).join(", ")}.`] };
  }).filter((thread) => thread.includeInReport).map(({ includeInReport: _includeInReport, ...thread }) => thread);
}

/** Read-only evidence report. It does not compare or claim transcript equality. */
export async function inspectLinkedThreads(paths: TargetPaths, options: InspectLinkedThreadsOptions = {}): Promise<LinkedThreadsReport> {
  if (!existsSync(paths.dbPath)) throw safetyError(`T3 database not found: ${paths.dbPath}`);
  const runtime = await inspectRuntime(paths);
  const db = new Database(paths.dbPath, { readonly: true, fileMustExist: true });
  try {
    const schema = validateTargetDatabase(db);
    const v2 = isV2Database(db);
    const threads = buildRows(db, v2, options);
    return {
      schemaVersion: 1, target: paths.dbPath, migration: schema.migration, generatedAt: new Date().toISOString(),
      provisional: runtime.live, runtime: { live: runtime.live, ...(runtime.pid ? { pid: runtime.pid } : {}), ...(runtime.origin ? { origin: runtime.origin } : {}) },
      transcriptEquality: "not_assessed", threads,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "ImporterError") throw error;
    throw compatibilityError(`Cannot inspect linked threads: ${error instanceof Error ? error.message : String(error)}`);
  } finally { db.close(); }
}
