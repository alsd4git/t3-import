import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    exclude: ["repos/**", "node_modules/**", "dist/**"],
    maxWorkers: 2,
    minWorkers: 1,
    // The SQLite integration cases include real backups and filesystem writes.
    // Windows hosted runners can exceed Vitest's 5s default on the same cases.
    testTimeout: process.platform === "win32" ? 20_000 : 5_000,
  },
});
