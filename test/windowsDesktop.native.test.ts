import { openSync, closeSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { windowsFileOwners } from "../src/target/windowsDesktop.js";

describe.skipIf(process.platform !== "win32")("Windows native file ownership", () => {
  it("finds the actual holder of a file with a quoted path using Restart Manager", async () => {
    const root = mkdtempSync(join(tmpdir(), "t3-file-owners-"));
    const path = join(root, "database 'quoted'.sqlite");writeFileSync(path, "fixture");
    const fd = openSync(path, "r+");
    try { expect(await windowsFileOwners(path)).toContain(process.pid); }
    finally { closeSync(fd);rmSync(root, { recursive: true, force: true }); }
  }, 30_000);
});
