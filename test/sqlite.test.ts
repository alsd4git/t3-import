import { beforeEach, expect, it, vi } from "vitest";

const { open } = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("better-sqlite3", () => ({ default: vi.fn(function () { return open(); }) }));
import { assertSQLiteDependency, GLOBAL_SQLITE_REPAIR, inspectSQLiteDependency } from "../src/core/sqlite.js";

beforeEach(() => { open.mockReset(); });

it("opens and queries an in-memory database, then closes it", () => {
  const get = vi.fn();
  const close = vi.fn();
  open.mockReturnValue({ prepare: vi.fn().mockReturnValue({ get }), close });
  expect(inspectSQLiteDependency()).toEqual({ available: true });
  expect(get).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});

it.each([
  ["Could not locate the bindings file. Tried:\nprivate/path/better_sqlite3.node", "missing-native"],
  ["Cannot find module '/path/better_sqlite3.node'", "missing-native"],
  ["compiled against a different NODE_MODULE_VERSION", "incompatible-native"],
  ["invalid ELF header", "incompatible-native"],
])("diagnoses a native addon failure: %s", (message, reason) => {
  open.mockImplementation(() => { throw new Error(message); });
  expect(inspectSQLiteDependency()).toMatchObject({ available: false, reason, repairCommand: GLOBAL_SQLITE_REPAIR });
  const status = inspectSQLiteDependency();
  expect(!status.available && status.message).not.toContain("private/path");
  expect(() => assertSQLiteDependency()).toThrow(GLOBAL_SQLITE_REPAIR);
});

it("does not recommend npm rebuild for an unrelated SQLite error", () => {
  const close = vi.fn();
  open.mockReturnValue({ prepare: () => { throw new Error("out of memory"); }, close });
  expect(inspectSQLiteDependency()).toEqual({ available: false, reason: "unavailable", message: "SQLite dependency check failed: out of memory" });
  expect(close).toHaveBeenCalledOnce();
});

it("recognizes a dynamic-loader error by code even when the OS message varies", () => {
  open.mockImplementation(() => { throw Object.assign(new Error("The specified module could not be found."), { code: "ERR_DLOPEN_FAILED" }); });
  expect(inspectSQLiteDependency()).toMatchObject({ available: false, reason: "incompatible-native", repairCommand: GLOBAL_SQLITE_REPAIR });
});
