// This entry is bundled with the pinned upstream implementation, not run from
// the checkout. No server, provider adapter, or outbox worker is started.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { OrchestrationV2DomainEventJson } from "@t3tools/contracts";
import * as ApplicationStore from "../../artifacts/t3-v010/apps/server/src/persistence/OrchestrationEventStore.ts";
import * as EventStore from "../../artifacts/t3-v010/apps/server/src/orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../artifacts/t3-v010/apps/server/src/orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../artifacts/t3-v010/apps/server/src/orchestration-v2/ProjectStore.ts";
import * as EventSink from "../../artifacts/t3-v010/apps/server/src/orchestration-v2/EventSink.ts";
import { runMigrations } from "../../artifacts/t3-v010/apps/server/src/persistence/Migrations.ts";
import * as LegacyImport from "../../artifacts/t3-v010/apps/server/src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts";

export const reference = __T3_REFERENCE__;
const decodeEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEventJson);
export function validateEvents(events) {
  for (const event of events) if (event.aggregateKind !== "project") decodeEvent(event);
}

function layers(filename) {
  const sql = NodeSqliteClient.layer({ filename });
  const appStore = ApplicationStore.layer.pipe(Layer.provide(sql));
  const store = EventStore.layerFromOrchestrationEventStore.pipe(Layer.provide(appStore));
  const projections = ProjectionStore.layer.pipe(Layer.provide(sql));
  const sink = EventSink.layer.pipe(Layer.provide(Layer.mergeAll(store, projections, sql)));
  const legacy = LegacyImport.layer.pipe(Layer.provide(Layer.mergeAll(sink, sql)));
  return Layer.mergeAll(sink, legacy, appStore, ProjectStore.layer.pipe(Layer.provide(sql)), sql);
}

export async function writeEvents(filename, events) {
  validateEvents(events);
  return Effect.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sink = yield* EventSink.EventSinkV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const application = yield* ApplicationStore.OrchestrationEventStore;
    return yield* sql.withTransaction(Effect.gen(function* () {
      const results = [];
      for (const input of events) {
        if (input.aggregateKind === "project") {
          const stored = yield* application.appendProjectEvent(input.projectEvent);
          yield* projects.apply(stored);
          results.push({ id: input.projectEvent.eventId, sequence: stored.sequence });
        } else {
          if (input.type === "turn-item.updated" && input.importMetadata?.t3ImportKey) {
            // Like LegacyV1ThreadImporter, reserve passive-history positions
            // before normalization. Unlike its initial cutover, an incremental
            // import can follow real runs (whose ordinals start at 1,000,000).
            // Allocate after every existing item, not in the pre-run bucket.
            yield* sql`
              INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
              SELECT ${input.threadId}, ${input.payload.id}, COALESCE(MAX(ordinal), 0) + 1
              FROM orchestration_v2_turn_item_positions WHERE thread_id = ${input.threadId}
              ON CONFLICT(thread_id, turn_item_id) DO NOTHING
            `;
          }
          const stored = yield* sink.write({ events: [decodeEvent(input)] });
          for (const entry of stored) {
            // Preserve importer identity/checkpoints beside T3's envelope metadata.
            // The official sink owns all projection and event writes.
            if (input.importMetadata) yield* sql`
              UPDATE orchestration_events
              SET metadata_json = json_patch(metadata_json, ${JSON.stringify(input.importMetadata)})
              WHERE event_id = ${entry.event.id}
            `;
            results.push({ id: entry.event.id, sequence: entry.sequence });
          }
        }
      }
      return results;
    }));
  }).pipe(Effect.provide(layers(filename))));
}

// Test/fixture generation only. Production writes never run database migrations.
export async function createSchema(filename) {
  return Effect.runPromise(Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type DESC, name`;
    const migrations = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
    return { ddl: rows.map((row) => row.sql), migrations };
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename }))));
}

export async function importLegacy(filename) {
  return Effect.runPromise(Effect.gen(function* () {
    const importer = yield* LegacyImport.LegacyV1ThreadImporter;
    yield* importer.reconcileShells;
    yield* importer.importPendingTranscripts;
  }).pipe(Effect.provide(layers(filename))));
}
