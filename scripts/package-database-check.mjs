import { createRequire } from "node:module";

const [packageManifest, filename] = process.argv.slice(2);
if (!packageManifest || !filename) throw new Error("Expected installed package manifest and synthetic database path.");
const Database = createRequire(packageManifest)("better-sqlite3");
const database = new Database(filename, { readonly: true, fileMustExist: true });
try {
  const integrity = database.pragma("integrity_check", { simple: true });
  if (integrity !== "ok") throw new Error(`Synthetic T3 database integrity check returned ${integrity}.`);
  if (database.pragma("foreign_key_check").length) throw new Error("Synthetic T3 database has invalid foreign keys.");
  const migration = database.prepare("SELECT MAX(migration_id) migration FROM effect_sql_migrations").get().migration;
  if (migration !== 67) throw new Error(`Synthetic T3 database used migration ${migration}; expected 67.`);
  const messageCount = database.prepare("SELECT COUNT(*) count FROM orchestration_v2_projection_messages").get().count;
  if (messageCount !== 4) throw new Error(`Packed CLI import/sync produced ${messageCount} messages; expected 4.`);
  const effects = database.prepare("SELECT COUNT(*) count FROM orchestration_v2_effect_outbox").get().count;
  if (effects !== 0) throw new Error(`Packed historical import enqueued ${effects} provider effects.`);
} finally {
  database.close();
}
