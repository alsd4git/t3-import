import type Database from "better-sqlite3";

/** Matches T3 0.1.5 ProjectionStore.getOpenRemoteDelegatedTasks, including owed stops. */
export function openRemoteDelegatedTasks(db: Database.Database, threadId?: string): Array<{ threadId: string; taskId: string }> {
  return db.prepare(`SELECT thread_id threadId, subagent_id taskId
    FROM orchestration_v2_projection_subagents
    WHERE origin='app_owned' AND child_thread_id IS NULL
      AND json_type(payload_json,'$.remoteChild')='object'
      AND (
        json_type(payload_json,'$.result')='null'
        OR (json_extract(payload_json,'$.status') IN ('cancelled','interrupted')
          AND json_type(payload_json,'$.remoteChild.stoppedThere') IS NOT 'true')
        OR json_type(payload_json,'$.remoteChild.stoppedThere')='false'
      )${threadId === undefined ? "" : " AND thread_id=?"}`)
    .all(...(threadId === undefined ? [] : [threadId])) as Array<{ threadId: string; taskId: string }>;
}

/** Terminal app-owned tasks can still owe a completion notification to their parent.
 * Optional delivery metadata is absent on legitimate legacy/native history.
 */
export function pendingSubagentDeliveries(db: Database.Database, threadId?: string): Array<{ threadId: string; taskId: string }> {
  return db.prepare(`SELECT thread_id threadId, subagent_id taskId
    FROM orchestration_v2_projection_subagents
    WHERE origin='app_owned' AND status IN ('completed','failed','cancelled','interrupted')
      AND json_extract(payload_json,'$.completionDelivery.state') IN ('pending','claimed')${threadId === undefined ? "" : " AND thread_id=?"}`)
    .all(...(threadId === undefined ? [] : [threadId])) as Array<{ threadId: string; taskId: string }>;
}
