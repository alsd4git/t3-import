import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    exclude: ["repos/**", "node_modules/**", "dist/**"],
    maxWorkers: 2,
    minWorkers: 1,
    // The SQLite integration cases include real backups and filesystem writes.
    // Multi-step sync/replace cases exceed 20s on hosted Windows runners.
    testTimeout: process.platform === "win32" ? 60_000 : 5_000,
  },
});
