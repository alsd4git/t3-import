import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/demo/capture.test.tsx"],
    testTimeout: 10_000,
    maxWorkers: 1,
    minWorkers: 1,
  },
});
