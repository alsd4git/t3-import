import { describe, expect, it, vi } from "vitest";
import { discoverWindowsDesktop, closeWindowsDesktop, startWindowsDesktop, sameWindowsDesktop, windowsRecoveryCommand, type WindowsDesktop } from "../src/target/windowsDesktop.js";
import { resolveTargetPaths } from "../src/target/config.js";

const desktop: WindowsDesktop = { pid: 200, started: "2026-11-09T00:00:00Z", executable: "C:\\Programs\\T3 Code.exe", sha256: "a".repeat(64), sessionId: 1, ownerSid: "S-1-5-21-1", runtimePid: 201, runtimeStarted: "2026-11-09T00:00:01Z" };
describe("Windows desktop command boundaries", () => {
  it("keeps executable and database names as JSON data, not PowerShell source", async () => {
    const hostile = "C:\\a'; Stop-Process -Id 1; #.exe";
    const run = vi.fn().mockResolvedValueOnce("[201]").mockResolvedValue(JSON.stringify(desktop));
    await discoverWindowsDesktop(resolveTargetPaths({ dbPath: hostile }), 201, run);
    await closeWindowsDesktop({ ...desktop, executable: hostile }, run);
    await startWindowsDesktop({ ...desktop, executable: hostile }, run);
    for (const [script] of run.mock.calls) {
      expect(script).not.toContain(hostile);
      expect(script).not.toContain("Stop-Process");
    }
  });
  it("rejects malformed or mismatched ownership reports", async () => {
    for (const report of [{ ...desktop, runtimePid: 999 }, { ...desktop, pid: 0 }, { ...desktop, sha256: "bad" }, { ...desktop, sessionId: 0 }]) {
      await expect(discoverWindowsDesktop(resolveTargetPaths(), 201, vi.fn().mockResolvedValueOnce("[201]").mockResolvedValue(JSON.stringify(report)))).rejects.toThrow("Invalid Windows desktop ownership report");
    }
  });
  it("compares creation times and binary identity as well as PIDs", () => {
    expect(sameWindowsDesktop({ ...desktop }, desktop)).toBe(true);
    expect(sameWindowsDesktop({ ...desktop, runtimeStarted: "reused" }, desktop)).toBe(false);
    expect(sameWindowsDesktop({ ...desktop, sha256: "b".repeat(64) }, desktop)).toBe(false);
    expect(sameWindowsDesktop(undefined, desktop)).toBe(false);
  });
  it("quotes recovery paths for PowerShell", () => {
    expect(windowsRecoveryCommand({ ...desktop, executable: "C:\\a'b.exe" })).toBe("Start-Process -FilePath 'C:\\a''b.exe'");
  });
});
