import type Database from "better-sqlite3";
import { checkpointForThread } from "../core/checkpoint.js";
import { canonicalPath, deterministicUuid, isObject, stringValue } from "../core/util.js";
import { compatibilityError, safetyError } from "../core/errors.js";
import type { PlannedEvent, PlannedThread } from "./importer.js";
import type { CanonicalThread } from "../core/types.js";
import { threadWorkingDirectory } from "./destination.js";
import { targetMigration } from "./schema.js";
import { v2Profiles } from "./v2Profiles.js";
import { openRemoteDelegatedTasks } from "./v2Work.js";
import { sourceDriver, nativeSessionId } from "../core/providers.js";

type Json = Record<string, unknown>;
interface V2Event extends Json { id: string; threadId: string; type: string; occurredAt: string; payload: Json }
interface RuntimeModule {
  validateEvents(events: Json[]): void;
  writeEvents(filename: string, events: Json[]): Promise<Array<{ id: string; sequence: number }>>;
}

// The published package carries the same pinned runtime as the source checkout.
async function runtime(db: Database.Database): Promise<RuntimeModule> {
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  if (!major || major < 22 || (major === 22 && (minor! < 21 || (minor === 21 && patch! < 1))) || major === 23) throw compatibilityError("T3 V2 operations require Node.js 22.21.1+ or 24+. Use a supported LTS runtime.");
  const profile = v2Profiles[targetMigration(db)];
  if (!profile) throw compatibilityError("No pinned V2 runtime for this database.");
  const url = new URL(`../../vendor/${profile.directory}/runtime.mjs`, import.meta.url);
  return import(url.href) as Promise<RuntimeModule>;
}

export function v2Thread(db: Database.Database, threadId: string): Json | undefined {
  const row = db.prepare("SELECT payload_json payload FROM orchestration_v2_projection_threads WHERE thread_id=?").get(threadId) as { payload: string } | undefined;
  return row ? JSON.parse(row.payload) as Json : undefined;
}

export function assertV2ThreadSettled(db: Database.Database, threadId: string): void {
  const pendingImport = db.prepare("SELECT 1 FROM orchestration_v2_legacy_imports WHERE thread_id=? AND transcript_imported_at IS NULL").get(threadId);
  if (pendingImport) throw safetyError("T3 has not finished migrating this thread's V1 transcript. Open the thread in T3 and let migration finish before synchronizing.");
  const activeRun = db.prepare("SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=? AND status NOT IN ('completed','failed','cancelled','interrupted','rolled_back') LIMIT 1").get(threadId);
  const activeSession = db.prepare(`SELECT 1 FROM orchestration_v2_projection_provider_sessions s
    JOIN orchestration_v2_projection_provider_session_bindings b USING(provider_session_id)
    WHERE b.thread_id=? AND s.status IN ('starting','running','waiting') LIMIT 1`).get(threadId);
  const pendingEffect = db.prepare("SELECT 1 FROM orchestration_v2_effect_outbox WHERE thread_id=? AND status IN ('pending','running') LIMIT 1").get(threadId);
  const nativeBackgroundWork = v2ProviderThreads(db, threadId).some((row) => Array.isArray(row.pendingBackgroundTasks) && row.pendingBackgroundTasks.length > 0);
  const waitingLink = db.prepare("SELECT 1 FROM orchestration_v2_projection_turn_items WHERE thread_id=? AND type='link_request' AND status='waiting' LIMIT 1").get(threadId);
  const openRemoteTask = openRemoteDelegatedTasks(db, threadId).length > 0;
  if (activeRun || activeSession || pendingEffect || nativeBackgroundWork || waitingLink || openRemoteTask) throw safetyError("T3 V2 has unfinished work for this thread. Settle or stop it in T3 before synchronizing or replacing its history.");
}

export function v2ProviderThreads(db: Database.Database, threadId?: string): Json[] {
  const rows = db.prepare(`SELECT payload_json payload FROM orchestration_v2_projection_provider_threads${threadId ? " WHERE thread_id=?" : ""}`).all(...(threadId ? [threadId] : [])) as Array<{ payload: string }>;
  return rows.map((row) => JSON.parse(row.payload) as Json);
}

export function isV2ProviderSubagent(thread: Json | undefined): boolean {
  return isObject(thread?.lineage) && thread.lineage.relationshipToParent === "subagent";
}

export function v2SourceConflict(db: Database.Database, threadId: string, source: CanonicalThread): string | undefined {
  const current = v2Thread(db, threadId);
  if (isV2ProviderSubagent(current)) return "Native provider-managed subagent history is not a writable synchronization target.";
  const driver = sourceDriver(source.source);
  const linkedThreads = new Set(v2ProviderThreads(db).filter((row) => row.driver === driver && isObject(row.nativeThreadRef)
    && row.nativeThreadRef.nativeId === source.sourceSessionId && typeof row.appThreadId === "string"
    && !v2Thread(db, row.appThreadId)?.deletedAt).map((row) => String(row.appThreadId)));
  linkedThreads.add(threadId);
  if (linkedThreads.size > 1) return "Multiple V2 threads refer to this source provider session. Resolve the ambiguous binding before synchronizing.";
  const providerThreads = v2ProviderThreads(db, threadId);
  const active = providerThreads.find((row) => row.id === current?.activeProviderThreadId);
  const ref = active && isObject(active.nativeThreadRef) ? active.nativeThreadRef : undefined;
  if (ref && (ref.driver !== driver || ref.nativeId !== source.sourceSessionId)) return "The V2 thread now uses a different native provider session. Preserve both histories.";
  if (active && active.providerInstanceId !== current?.providerInstanceId) return "The V2 thread has a pending provider-instance switch. Resolve it in T3 before synchronizing.";
  if (canonicalPath(threadWorkingDirectory(db, threadId, source.workspace).cwd) !== canonicalPath(source.workspace)) return "Source and V2 working directories differ. Review the workspace change before synchronizing.";
  return undefined;
}

function appThread(plan: PlannedThread, payload: Json): Json {
  return {
    createdBy: "system", creationSource: "server", id: plan.threadId,
    projectId: plan.projectId, title: plan.thread.title,
    providerInstanceId: plan.provider.instanceId,
    modelSelection: payload.modelSelection,
    runtimeMode: payload.runtimeMode ?? "full-access", interactionMode: payload.interactionMode ?? "default",
    branch: payload.branch ?? null, worktreePath: payload.worktreePath ?? null,
    activeProviderThreadId: null, historyOrigin: "v1_import",
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: plan.threadId },
    forkedFrom: null, createdAt: payload.createdAt, updatedAt: payload.updatedAt,
    archivedAt: null, settledOverride: null, settledAt: null,
    lastVisitedAt: null, deletedAt: null,
  };
}

/** Convert the shared historical plan to V2's passive transcript events. */
export function v2Events(db: Database.Database, plan: PlannedThread): Json[] {
  const events: Json[] = [];
  const storedThread = v2Thread(db, plan.threadId);
  const head = plan.thread.source === "claude" ? plan.thread.resumeCursor?.resumeSessionAt
    : plan.thread.source === "opencode" ? plan.thread.resumeCursor?.headMessageId : undefined;
  let thread = storedThread;
  let ordinal = (db.prepare("SELECT COALESCE(MAX(ordinal),0) n FROM orchestration_v2_projection_turn_items WHERE thread_id=?").get(plan.threadId) as { n: number }).n;
  const emit = (row: PlannedEvent, type: string, payload: Json, suffix = ""): V2Event => {
    const value: V2Event = {
      id: suffix ? deterministicUuid(`${row.eventId}:${suffix}`) : row.eventId,
      threadId: row.streamId, type, occurredAt: row.occurredAt,
      driver: plan.provider.adapterKey, providerInstanceId: plan.provider.instanceId, payload,
      importMetadata: { ...row.metadata, t3ImportKey: row.key },
    };
    events.push(value);
    return value;
  };
  const itemBase = (row: PlannedEvent, id: string): Json => ({
    id, threadId: plan.threadId, runId: null, nodeId: null,
    providerThreadId: null, providerTurnId: row.metadata.providerTurnId ?? null,
    nativeItemRef: null, parentItemId: null, ordinal: ++ordinal,
    status: "completed", title: null, startedAt: row.occurredAt,
    completedAt: row.occurredAt, updatedAt: row.occurredAt,
  });
  // V1 settles before its per-projector replay. V2 commits projections together,
  // so record each terminal boundary after that turn's messages and activities.
  const ordered: PlannedEvent[] = [];
  let terminal: PlannedEvent | undefined;
  for (const row of plan.events) {
    if (/^turn\.\d+\.user$/u.test(row.key) && terminal) { ordered.push(terminal); terminal = undefined; }
    if (row.type === "thread.session-set" && row.key.endsWith(".settled")) terminal = row;
    else ordered.push(row);
  }
  if (terminal) ordered.push(terminal);
  for (const row of ordered) {
    if (row.aggregateKind === "project") {
      events.push({ aggregateKind: "project", projectEvent: {
        eventId: row.eventId, type: row.type, aggregateKind: "project", aggregateId: row.streamId,
        occurredAt: row.occurredAt, commandId: null, causationEventId: null,
        correlationId: null, payload: row.payload, metadata: row.metadata,
      } });
      continue;
    }
    if (row.type === "thread.created") {
      thread = appThread(plan, row.payload);
      const created = emit(row, row.type, thread);
      created.importMetadata = { ...(created.importMetadata as Json), t3Import: {
        schemaVersion: 1, source: plan.thread.source, sourceSessionId: plan.thread.sourceSessionId,
        sourceKey: plan.thread.sourceKey, identitySeed: plan.thread.sourceKey, canonical: true,
        resumable: plan.resumable,
        ...(isObject(row.metadata.t3Import) ? row.metadata.t3Import : {}),
      } };
    } else if (row.type === "thread.meta-updated" || row.type === "thread.deleted") {
      if (!thread) throw safetyError(`Missing V2 thread ${plan.threadId}.`);
      thread = { ...thread, ...row.payload, updatedAt: row.occurredAt };
      delete thread.threadId;
      emit(row, row.type === "thread.deleted" ? row.type : "thread.metadata-updated", thread);
    } else if (row.type === "thread.message-sent") {
      const p = row.payload;
      emit(row, "message.updated", {
        id: p.messageId, threadId: plan.threadId, runId: null, nodeId: null,
        role: p.role, text: p.text, attachments: p.attachments ?? [], streaming: false,
        createdAt: p.createdAt, updatedAt: p.updatedAt,
        createdBy: p.role === "user" ? "user" : "agent", creationSource: "server",
      });
      emit(row, "turn-item.updated", {
        ...itemBase(row, deterministicUuid(`${row.eventId}:item`)),
        type: p.role === "user" ? "user_message" : "assistant_message",
        messageId: p.messageId, text: p.text,
        ...(p.role === "user" ? { createdBy: "user", creationSource: "server", inputIntent: "turn_start", attachments: p.attachments ?? [] } : { streaming: false }),
      }, "item");
    } else if (row.type === "thread.activity-appended") {
      const activity = row.payload.activity as Json;
      const body = activity.payload as Json;
      const data = isObject(body.data) ? body.data : {};
      const source = isObject(data.item) ? data.item : data;
      const base = itemBase(row, String(activity.id));
      let item: Json;
      if (activity.kind === "reasoning.summary") item = { ...base, type: "reasoning", text: stringValue(source.text) ?? String(activity.summary), streaming: false };
      else if (body.itemType === "command_execution") item = { ...base, type: "command_execution", input: stringValue(source.command) ?? String(activity.summary), ...(typeof source.aggregated_output === "string" ? { output: source.aggregated_output } : {}) };
      else item = { ...base, type: "system_notice", message: `${activity.summary}${Object.keys(body).length ? `\n${JSON.stringify(body)}` : ""}` };
      emit(row, "turn-item.updated", item);
    } else if (row.type === "thread.proposed-plan-upserted") {
      const proposed = row.payload.proposedPlan as Json;
      emit(row, "turn-item.updated", { ...itemBase(row, String(proposed.id)), type: "proposed_plan", planId: proposed.id, markdown: proposed.planMarkdown, streaming: false });
    } else if (row.type === "thread.session-set" && row.key.endsWith(".settled")) {
      const session = row.payload.session as Json;
      const status = session.status === "error" ? "failed" : session.status === "ready" ? "completed" : "interrupted";
      // A completed turn needs a durable terminal boundary for sync recovery,
      // but system_notice renders as a warning in T3. Reassert its last item
      // unchanged instead of creating a visible notice for normal completion.
      const lastItem = status === "completed"
        ? events.findLast((event) => event.type === "turn-item.updated")
        : undefined;
      if (status === "completed" && !lastItem) throw safetyError("A completed imported turn has no transcript item.");
      const payload = lastItem ? lastItem.payload as Json : {
        ...itemBase(row, deterministicUuid(`${row.eventId}:terminal`)),
        type: "system_notice", status,
        message: `Imported turn ${status}${session.lastError ? `: ${session.lastError}` : "."}`,
      };
      const value = emit(row, "turn-item.updated", payload);
      (value.importMetadata as Json).t3ImportTerminalStatus = status;
    }
  }
  if (!thread) throw safetyError(`Missing V2 thread ${plan.threadId}.`);
  if (plan.resumable && plan.thread.resumeCursor) {
    const existing = v2ProviderThreads(db, plan.threadId);
    if (existing.length === 0) {
      // Mirrors thread.create.importedNativeThread: a durable native ref, no
      // fabricated runtime session and no historical provider execution.
      const nativeId = nativeSessionId(plan.thread);
      if (typeof nativeId !== "string" || !nativeId) throw safetyError("The source has no native provider thread ID.");
      const id = deterministicUuid(`t3-import:v2:provider-thread:${plan.threadId}:${plan.provider.instanceId}:${nativeId}`);
      const ref = { driver: plan.provider.adapterKey, nativeId, strength: "strong" };
      events.push({ id: deterministicUuid(`${id}:created`), threadId: plan.threadId,
        type: "provider-thread.updated", driver: plan.provider.adapterKey, providerInstanceId: plan.provider.instanceId,
        occurredAt: plan.thread.updatedAt,
        payload: { id, driver: plan.provider.adapterKey, providerInstanceId: plan.provider.instanceId,
          providerSessionId: null, appThreadId: plan.threadId, ownerNodeId: null,
          nativeThreadRef: ref,
          nativeConversationHeadRef: head
            ? { driver: plan.provider.adapterKey, nativeId: head, strength: "weak" } : null,
          status: "not_loaded",
          firstRunOrdinal: null, lastRunOrdinal: null, handoffIds: [], forkedFrom: null,
          createdAt: plan.thread.createdAt, updatedAt: plan.thread.updatedAt },
      });
    } else if (plan.thread.source === "claude" || plan.thread.source === "opencode") {
      const current = existing.find((row) => row.id === storedThread?.activeProviderThreadId) ?? (existing.length === 1 ? existing[0] : undefined);
      const ref = current && isObject(current.nativeThreadRef) ? current.nativeThreadRef : undefined;
      if (!current || ref?.driver !== plan.provider.adapterKey || ref.nativeId !== plan.thread.sourceSessionId) throw safetyError("Cannot update an ambiguous or rebound V2 provider thread.");
      const previousHead = isObject(current.nativeConversationHeadRef) ? current.nativeConversationHeadRef.nativeId : undefined;
      if (previousHead !== head) events.push({ id: deterministicUuid(`t3-import:head:${plan.threadId}:${head ?? plan.fingerprint}`),
        threadId: plan.threadId, type: "provider-thread.updated", occurredAt: plan.thread.updatedAt,
        driver: plan.provider.adapterKey, providerInstanceId: plan.provider.instanceId,
        payload: { ...current, nativeConversationHeadRef: head
          ? { driver: plan.provider.adapterKey, nativeId: head, strength: "weak" } : null,
          updatedAt: plan.thread.updatedAt },
      });
    }
  }
  if (events.length) {
    const last = events.at(-1)!;
    last.importMetadata = { ...(isObject(last.importMetadata) ? last.importMetadata : {}),
      t3ImportCheckpoint: plan.checkpoint ?? checkpointForThread(plan.thread),
    };
  }
  return events;
}

export async function prepareV2Write(db: Database.Database, plans: PlannedThread[]): Promise<{ write(): Promise<Map<PlannedThread, { first: number; last: number }>> }> {
  const module = await runtime(db);
  const batches = plans.map((plan) => {
    const events = v2Events(db, plan);
    plan.targetEventCount = events.length;
    return { plan, events };
  });
  const events = batches.flatMap((batch) => batch.events);
  module.validateEvents(events);
  return { write: async () => {
    const written = new Map((await module.writeEvents(db.name, events)).map((row) => [row.id, row.sequence]));
    return new Map(batches.map(({ plan, events }) => {
      const sequences = events.map((row) => written.get(String(row.id ?? (row.projectEvent as Json).eventId))!);
      return [plan, { first: Math.min(...sequences), last: Math.max(...sequences) }];
    }));
  } };
}
