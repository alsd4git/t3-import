import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type {
  CanonicalActivity,
  CanonicalConversation,
  CanonicalMessage,
  CanonicalThread,
  CanonicalTurn,
  DiscoveryOptions,
  SourceAdapter,
  SourceAttachment,
  SourceSummary,
} from "../core/types.js";
import { canonicalPath, deriveTitle, isObject, isoTimestamp, stringValue, truncate } from "../core/util.js";
import { sourceError } from "../core/errors.js";

type Row = Record<string, unknown>;
type OpenCodeMessage = {
  id: string;
  session_id: string;
  type: string;
  seq: number;
  time_created: number;
  time_updated: number;
  data: string;
};
type Session = {
  id: string;
  parent_id: string | null;
  fork_session_id: string | null;
  directory: string;
  title: string | null;
  version: string;
  agent: string | null;
  model: string | null;
  time_created: number;
  time_updated: number;
  time_idle: number | null;
  idle_outcome: string | null;
  time_archived?: number | null;
};

const SESSION_COLUMNS = [
  "id", "parent_id", "fork_session_id", "directory", "title", "version",
  "agent", "model", "time_created", "time_updated", "time_idle", "idle_outcome",
];
const MESSAGE_COLUMNS = ["id", "session_id", "type", "seq", "time_created", "time_updated", "data"];
const MAX_INLINE_ATTACHMENT_BYTES = 8 * 1024 * 1024;

function databasePath(): string {
  if (process.env.OPENCODE_DB?.trim()) return resolve(process.env.OPENCODE_DB.trim());
  const dataHome = process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
  return join(dataHome, "opencode", "opencode.db");
}

function requiredColumns(db: Database.Database, table: string, required: string[]): string[] {
  const actual = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((column) => column.name));
  return required.filter((column) => !actual.has(column));
}

function openDatabase(path: string): Database.Database {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON");
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Row[]).map((row) => row.name));
  if (!tables.has("session_v2") || !tables.has("session_message")) {
    db.close();
    throw sourceError("OpenCode database is not using the supported V2 session schema; expected session_v2 and session_message tables");
  }
  const missing = [
    ...requiredColumns(db, "session_v2", SESSION_COLUMNS).map((column) => `session_v2.${column}`),
    ...requiredColumns(db, "session_message", MESSAGE_COLUMNS).map((column) => `session_message.${column}`),
  ];
  if (missing.length) {
    db.close();
    throw sourceError(`Unsupported OpenCode V2 database schema; missing columns: ${missing.join(", ")}`);
  }
  return db;
}

function readSnapshot<T>(path: string, operation: (db: Database.Database) => T): T {
  let db: Database.Database | undefined;
  try {
    db = openDatabase(path);
    db.exec("BEGIN");
    const result = operation(db);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db?.exec("ROLLBACK"); } catch { /* transaction may not have started */ }
    if (error instanceof Error && error.name === "ImporterError") throw error;
    throw sourceError(`Unable to read OpenCode database at ${path}`, error);
  } finally {
    db?.close();
  }
}

function parseJson(value: string, label: string): Row {
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch (error) { throw sourceError(`Invalid ${label} JSON in OpenCode database`, error); }
  if (!isObject(parsed)) throw sourceError(`Invalid ${label} record in OpenCode database`);
  return parsed;
}

function sessionQuery(db: Database.Database, id?: string): Session[] {
  const available = new Set((db.prepare("PRAGMA table_info(session_v2)").all() as Row[]).map((column) => column.name));
  const fields = [...SESSION_COLUMNS, ...(available.has("time_archived") ? ["time_archived"] : [])].join(", ");
  const rows = id
    ? db.prepare(`SELECT ${fields} FROM session_v2 WHERE id = ?`).all(id)
    : db.prepare(`SELECT ${fields} FROM session_v2 ORDER BY time_updated DESC, id`).all();
  return rows as Session[];
}

function messagesQuery(db: Database.Database, sessionId: string): OpenCodeMessage[] {
  return db.prepare(`SELECT ${MESSAGE_COLUMNS.join(", ")} FROM session_message WHERE session_id = ? ORDER BY seq, id`).all(sessionId) as OpenCodeMessage[];
}

function timestamp(value: unknown, fallback: string): string {
  return isoTimestamp(value, fallback);
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.flatMap((part) => typeof part === "string" ? [part] : isObject(part) && typeof part.text === "string" ? [part.text] : []).join("\n");
  return "";
}

function attachmentList(value: unknown, messageId: string): { attachments: SourceAttachment[]; warnings: string[] } {
  if (!Array.isArray(value)) return { attachments: [], warnings: [] };
  const attachments: SourceAttachment[] = [];
  const warnings: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isObject(entry)) continue;
    const mimeType = stringValue(entry.mime) ?? stringValue(entry.mimeType);
    const rawPath = stringValue(entry.path);
    const url = stringValue(entry.url);
    let path: string | undefined;
    let remoteUrl: string | undefined;
    let data: Buffer | undefined;
    let actualMime = mimeType;
    let sizeBytes = typeof entry.size === "number" && Number.isSafeInteger(entry.size) && entry.size >= 0 ? entry.size : undefined;
    if (url?.startsWith("data:")) {
      const match = /^data:([^;,]+)(?:;[^,]*)?;base64,([A-Za-z0-9+/]*={0,2})$/iu.exec(url);
      if (!match || Math.floor(match[2]!.length * 3 / 4) > MAX_INLINE_ATTACHMENT_BYTES) {
        warnings.push(`Skipped unsupported or oversized inline OpenCode attachment ${messageId}:${index}.`);
        continue;
      }
      data = Buffer.from(match[2]!, "base64");
      sizeBytes = data.length;
      actualMime ??= match[1];
    } else if (url?.startsWith("file:")) {
      try { path = fileURLToPath(url); }
      catch { warnings.push(`Skipped invalid file URL attachment ${messageId}:${index}.`); continue; }
    } else if (url && /^https:\/\//iu.test(url)) {
      remoteUrl = url;
    } else if (url && /^[a-z][a-z0-9+.-]*:/iu.test(url)) {
      warnings.push(`Skipped attachment with unsupported URL scheme ${messageId}:${index}.`);
      continue;
    } else {
      path = rawPath ?? url;
    }
    if (!path && !remoteUrl && !data) continue;
    if (path && sizeBytes === undefined) {
      try { sizeBytes = statSync(path).size; } catch { sizeBytes = 0; }
    }
    const name = stringValue(entry.filename) ?? stringValue(entry.name) ?? (path ? path.split(/[\\/]/u).at(-1)! : `attachment-${index + 1}`);
    attachments.push({
      sourceId: `${messageId}:file:${index}`,
      name,
      mimeType: actualMime ?? "application/octet-stream",
      sizeBytes: sizeBytes ?? 0,
      ...(path ? { path } : {}),
      ...(remoteUrl ? { remoteUrl } : {}),
      ...(data ? { data } : {}),
    });
  }
  return { attachments, warnings };
}

function modelInfo(value: unknown): { name?: string; variant?: string } {
  let parsed = value;
  if (typeof value === "string" && value.trim().startsWith("{")) {
    try { parsed = JSON.parse(value); } catch { return value.trim() ? { name: value.trim() } : {}; }
  }
  if (typeof parsed === "string") return parsed.trim() ? { name: parsed.trim() } : {};
  if (!isObject(parsed)) return {};
  const provider = stringValue(parsed.providerID) ?? stringValue(parsed.providerId);
  const model = stringValue(parsed.modelID) ?? stringValue(parsed.modelId) ?? stringValue(parsed.id);
  const name = provider && model ? `${provider}/${model}` : model ?? provider;
  const variant = stringValue(parsed.variant);
  return {
    ...(name ? { name } : {}),
    ...(variant ? { variant } : {}),
  };
}

function toolOutput(state: Row): unknown {
  if (state.status === "error") return state.error ?? state.content ?? state;
  if (state.status === "completed") return state.content ?? "";
  return state.content ?? state;
}

interface MutableTurn {
  id: string;
  sequence: number;
  startedAt: string;
  status: CanonicalTurn["status"];
  completedAt?: string;
  terminalReason?: string;
  terminalError?: string;
  providerErrors: string[];
  user: CanonicalMessage;
  assistant: CanonicalMessage[];
  activities: CanonicalActivity[];
}

function toTurn(turn: MutableTurn): CanonicalTurn {
  return {
    id: turn.id,
    startedAt: turn.startedAt,
    ...(turn.completedAt ? { completedAt: turn.completedAt } : {}),
    status: turn.status,
    ...(turn.terminalReason ? { terminalReason: turn.terminalReason } : {}),
    ...(turn.terminalError ? { terminalError: turn.terminalError } : {}),
    user: turn.user,
    assistant: turn.assistant,
    activities: turn.activities,
    plans: [],
  };
}

function parseThread(session: Session, rows: OpenCodeMessage[], includeIncomplete: boolean): { thread: CanonicalThread; ignored: number; fingerprint: string } {
  if (!/^2\./u.test(session.version)) throw sourceError(`OpenCode session ${session.id} was created by unsupported version ${session.version}; this reader supports OpenCode 2.x sessions`);
  const fallback = timestamp(session.time_created, new Date(0).toISOString());
  const turns: MutableTurn[] = [];
  const pending: MutableTurn[] = [];
  let active: MutableTurn | undefined;
  let ignored = 0;
  let model = modelInfo(session.model).name ?? "default";
  let modelVariant = modelInfo(session.model).variant;
  const warnings: string[] = [];
  const settle = (status: CanonicalTurn["status"], time: string, reason?: string, error?: string): void => {
    if (!active) return;
    active.status = status;
    active.completedAt = time;
    if (reason) active.terminalReason = reason;
    const terminalError = error ?? (status === "failed" ? active.providerErrors.at(-1) : undefined);
    if (terminalError) active.terminalError = terminalError;
    if (status === "failed" || status === "interrupted") {
      active.activities.push({
        sourceId: `${active.id}:terminal`,
        timestamp: time,
        tone: status === "failed" ? "error" : "info",
        kind: status === "failed" ? "turn.failed" : "turn.interrupted",
        summary: status === "failed" ? "Turn failed" : "Turn interrupted",
        payload: { status, ...(reason ? { reason } : {}), ...(terminalError ? { detail: terminalError } : {}) },
      });
    }
    turns.push(active);
    active = undefined;
  };

  for (const row of rows) {
    const data = parseJson(row.data, `session message ${row.id}`);
    const time = timestamp(row.time_created, fallback);
    if (row.type === "user") {
      if (active) {
        pending.push(active);
        warnings.push(`OpenCode session contains an unsettled user message ${active.id} before ${row.id}; it remains incomplete.`);
        active = undefined;
      }
      const text = contentText(data.text);
      const attachments = attachmentList(data.files, row.id);
      warnings.push(...attachments.warnings);
      active = {
        id: row.id,
        sequence: row.seq,
        startedAt: time,
        status: "inProgress",
        user: {
          sourceId: row.id,
          role: "user",
          text: text || (Array.isArray(data.files) && data.files.length ? "[Attachment]" : ""),
          timestamp: time,
          attachments: attachments.attachments,
        },
        assistant: [],
        activities: [],
        providerErrors: [],
      };
    } else if (row.type === "assistant") {
      if (!active) continue;
      const assistantModel = modelInfo(data.model);
      if (assistantModel.name) {
        if (assistantModel.name !== model) modelVariant = assistantModel.variant;
        model = assistantModel.name;
      } else if (assistantModel.variant) {
        modelVariant = assistantModel.variant;
      }
      if (modelVariant === "default") modelVariant = undefined;
      const parts = Array.isArray(data.content) ? data.content : [];
      const textParts: string[] = [];
      for (const [index, rawPart] of parts.entries()) {
        if (!isObject(rawPart)) continue;
        const sourceId = `${row.id}:${index}`;
        if (rawPart.type === "text" && typeof rawPart.text === "string") {
          if (rawPart.text.length) textParts.push(rawPart.text);
        } else if (rawPart.type === "reasoning" && typeof rawPart.text === "string" && rawPart.text.trim()) {
          active.activities.push({ sourceId, timestamp: time, tone: "info", kind: "reasoning.summary", summary: "Reasoning", payload: { data: { item: { text: rawPart.text } } } });
        } else if (rawPart.type === "tool") {
          const state = isObject(rawPart.state) ? rawPart.state : {};
          const name = stringValue(rawPart.name) ?? "Tool";
          const failed = state.status === "error";
          const output = toolOutput(state);
          const detail = typeof output === "string" ? output : contentText(output);
          const toolId = stringValue(rawPart.id) ?? sourceId;
          active.activities.push({
            sourceId: toolId,
            timestamp: time,
            tone: failed ? "error" : "tool",
            kind: "tool.completed",
            summary: truncate(name, 120),
            payload: {
              itemType: "dynamic_tool_call",
              status: failed ? "failed" : state.status === "completed" ? "completed" : "inProgress",
              title: name,
              ...(detail ? { detail: truncate(detail) } : {}),
              data: { toolCallId: toolId, item: { name, input: state.input, output } },
            },
          });
        }
      }
      if (textParts.length) active.assistant.push({ sourceId: row.id, role: "assistant", text: textParts.join("\n"), timestamp: time, attachments: [] });
      if (data.error !== undefined || data.finish === "error") {
        const error = isObject(data.error)
          ? stringValue(data.error.message) ?? stringValue(data.error.name) ?? "OpenCode reported an error"
          : stringValue(data.error) ?? "OpenCode reported an error";
        active.providerErrors.push(error);
        active.activities.push({ sourceId: `${row.id}:provider-error`, timestamp: time, tone: "error", kind: "provider.error", summary: "OpenCode provider error", payload: { detail: error, retryable: true } });
      }
    } else if (row.type === "idle") {
      if (!active) continue;
      const outcome = stringValue(data.outcome) ?? session.idle_outcome ?? "succeeded";
      const status = outcome === "succeeded" ? "completed" : outcome === "failed" || outcome === "error" ? "failed" : "interrupted";
      settle(status, time, outcome, status === "failed" && !active.providerErrors.length ? "OpenCode turn ended with an error" : undefined);
    } else if (row.type === "system" || row.type === "synthetic") {
      warnings.push(`OpenCode ${row.type} message ${row.id} was retained in the original provider store and omitted from the visible transcript.`);
    } else {
      warnings.push(`OpenCode message ${row.id} has unsupported type ${row.type}; it remains in the provider store and was omitted from the visible transcript.`);
    }
  }
  if (active) ignored += 1;
  ignored += pending.length;
  if (!includeIncomplete && pending.some((incomplete) => turns.some((turn) => turn.sequence > incomplete.sequence))) {
    throw sourceError(`OpenCode session ${session.id} has an incomplete user message before a later settled turn; reload with incomplete turns included to preserve the conversation history`);
  }
  const canonicalTurns = [
    ...turns.filter((turn) => includeIncomplete || turn.status !== "inProgress"),
    ...(includeIncomplete ? pending : []),
    ...(includeIncomplete && active ? [active] : []),
  ].sort((left, right) => left.sequence - right.sequence).map(toTurn);
  if (!canonicalTurns.length && !active) throw sourceError(`OpenCode session ${session.id} contains no importable turns`);
  const firstTime = canonicalTurns[0]?.startedAt ?? pending[0]?.startedAt ?? active?.startedAt ?? fallback;
  const lastTurn = canonicalTurns.at(-1);
  const title = stringValue(session.title) ?? deriveTitle(canonicalTurns[0]?.user.text ?? active?.user.text ?? "");
  const digest = createHash("sha256");
  for (const row of rows) digest.update(`${row.seq}\0${row.id}\0${row.type}\0${row.time_updated}\0${row.data}\n`);
  const thread: CanonicalThread = {
    source: "opencode" as CanonicalThread["source"],
    sourceSessionId: session.id,
    sourceKey: `opencode:${session.id}`,
    currentBranch: true,
    title,
    workspace: session.directory,
    model,
    ...(modelVariant ? { modelOptions: [{ id: "variant", value: modelVariant }] } : {}),
    createdAt: firstTime,
    updatedAt: lastTurn?.completedAt ?? lastTurn?.assistant.at(-1)?.timestamp ?? active?.assistant.at(-1)?.timestamp ?? active?.user.timestamp ?? timestamp(session.time_updated, fallback),
    turns: canonicalTurns,
    ignoredInProgressTurns: ignored,
    ...(turns.length ? { resumeCursor: { sessionId: session.id, headMessageId: turns.at(-1)!.user.sourceId } } : {}),
    warnings: [...warnings, ...(session.fork_session_id ? ["OpenCode fork session; new prompts resume this fork session."] : [])],
  };
  return { thread, ignored, fingerprint: digest.digest("hex") };
}

export class OpenCodeSource implements SourceAdapter {
  readonly name: SourceAdapter["name"] = "opencode" as SourceAdapter["name"];

  async discover(options: DiscoveryOptions): Promise<SourceSummary[]> {
    const path = databasePath();
    return readSnapshot(path, (db) => {
      const summaries: SourceSummary[] = [];
      for (const session of sessionQuery(db)) {
        if (!/^2\./u.test(session.version)) throw sourceError(`OpenCode session ${session.id} was created by unsupported version ${session.version}; this reader supports OpenCode 2.x sessions`);
        if (session.time_archived != null) continue;
        if (session.parent_id) continue;
        if (options.workspace && canonicalPath(session.directory) !== canonicalPath(options.workspace)) continue;
        const createdAt = timestamp(session.time_created, new Date(0).toISOString());
        const updatedAt = timestamp(session.time_updated, createdAt);
        if (options.since && new Date(updatedAt) < options.since) continue;
        const rows = messagesQuery(db, session.id);
        const incomplete = rows.at(-1)?.type !== "idle";
        summaries.push({
          source: "opencode" as SourceSummary["source"],
          id: session.id,
          title: stringValue(session.title) ?? "OpenCode conversation",
          workspace: session.directory,
          path: path,
          createdAt,
          updatedAt,
          status: incomplete ? "incomplete" : "complete",
          branches: 1,
        });
      }
      return summaries;
    });
  }

  async load(summary: SourceSummary, options: DiscoveryOptions): Promise<CanonicalConversation> {
    const path = summary.path || databasePath();
    return readSnapshot(path, (db) => {
      const session = sessionQuery(db, summary.id)[0];
      if (!session) throw sourceError(`OpenCode session ${summary.id} was not found`);
      if (session.parent_id && !summary.parentId) throw sourceError(`OpenCode session ${summary.id} is a child session and was not selected explicitly`);
      const rows = messagesQuery(db, session.id);
      if (!rows.length) throw sourceError(`OpenCode session ${session.id} has no messages`);
      const parsed = parseThread(session, rows, options.includeIncomplete ?? false);
      const thread = parsed.thread;
      const visibleTurns = options.includeIncomplete ? thread.turns : thread.turns.filter((turn) => turn.status !== "inProgress");
      thread.turns = visibleTurns;
      return {
        summary: { ...summary, title: thread.title, status: parsed.ignored ? "incomplete" : "complete" },
        threads: [thread],
        fingerprint: parsed.fingerprint,
      };
    });
  }
}
