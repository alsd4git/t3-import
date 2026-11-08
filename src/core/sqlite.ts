import Database from "better-sqlite3";
import { compatibilityError } from "./errors.js";

export const GLOBAL_SQLITE_REPAIR = "npm rebuild --global better-sqlite3 --allow-scripts=better-sqlite3";

export type SQLiteDependencyStatus =
  | { available: true }
  | { available: false; reason: "missing-native" | "incompatible-native" | "unavailable"; message: string; repairCommand?: string };

/** Loading the JS package is insufficient: npm can install it without its addon. */
export function inspectSQLiteDependency(): SQLiteDependencyStatus {
  let database: Database.Database | undefined;
  try {
    database = new Database(":memory:");
    database.prepare("SELECT 1").get();
    return { available: true };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const missing = /Could not locate the bindings file|Cannot find module.*better_sqlite3/iu.test(detail);
    const incompatible = (cause instanceof Error && "code" in cause && cause.code === "ERR_DLOPEN_FAILED")
      || /NODE_MODULE_VERSION|Module did not self-register|invalid ELF header|wrong architecture|not a valid Win32|incompatible architecture/iu.test(detail);
    if (missing || incompatible) return {
      available: false,
      reason: missing ? "missing-native" : "incompatible-native",
      message: `The better-sqlite3 native module is ${missing ? "missing (its install script may have been blocked by npm)" : `incompatible with Node.js ${process.versions.node} on ${process.platform}/${process.arch}`}. For a global npm installation, repair it with: ${GLOBAL_SQLITE_REPAIR}. For a source checkout or local install, approve better-sqlite3's install script and rebuild it in that project.`,
      repairCommand: GLOBAL_SQLITE_REPAIR,
    };
    return { available: false, reason: "unavailable", message: `SQLite dependency check failed: ${detail.split("\n")[0]}` };
  } finally {
    database?.close();
  }
}

export function assertSQLiteDependency(): void {
  const status = inspectSQLiteDependency();
  if (!status.available) throw compatibilityError(status.message);
}
