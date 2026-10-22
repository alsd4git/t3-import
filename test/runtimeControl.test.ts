import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverRuntimeService, pauseIdleRuntime, type RuntimeStatus, type SystemctlRunner } from "../src/target/runtimeControl.js";
import { resolveTargetPaths } from "../src/target/config.js";
import { assertT3Closed, runtimeMaintenancePath } from "../src/target/schema.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "t3-runtime-control-")); roots.push(root);
  const paths = resolveTargetPaths({ t3Home: root });
  mkdirSync(paths.stateDir, { recursive: true });
  const procRoot = join(root, "proc");
  const group = "/user.slice/user-1000.slice/user@1000.service/app.slice/t3code.service";
  for (const [pid, parent] of [[101, 100], [100, 1]]) {
    const directory = join(procRoot, String(pid)); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "status"), `PPid:\t${parent}\n`);
    writeFileSync(join(directory, "cgroup"), `0::${group}\n`);
    writeFileSync(join(directory, "stat"), `${pid} (t3 runtime) ${["S", String(parent), ...Array(17).fill("0"), "42"].join(" ")}\n`);
  }
  const service = { scope: "user" as const, unit: "t3code.service", mainPid: 100, controlGroup: group };
  const status: RuntimeStatus = { exists: true, live: true, stale: false, pid: 101, origin: "http://127.0.0.1:3773", service, activity: { status: "idle", counts: {}, warnings: [], fingerprint: "initial-work" } };
  const stopped: RuntimeStatus = { ...status, live: false, stale: true };
  const run = vi.fn<SystemctlRunner>(async (args) => args.includes("show")
    ? `Id=t3code.service\nMainPID=0\nActiveState=inactive\nControlGroup=${group}\nTriggeredBy=\n` : "");
  const inspect = vi.fn().mockResolvedValueOnce(status).mockResolvedValueOnce(status).mockResolvedValue(stopped);
  const ready = vi.fn().mockResolvedValue(true);
  return { root, paths, procRoot, service, status, stopped, run, inspect, ready };
}

describe("managed runtime maintenance", () => {
  it("blocks other writers while the service is paused or recovery is pending", async () => {
    const f = fixture();
    const marker = runtimeMaintenancePath(f.paths);
    writeFileSync(marker, JSON.stringify({ ownerPid: process.pid + 1 }));
    await expect(assertT3Closed(f.paths)).rejects.toThrow("owned by another command");
    writeFileSync(marker, "invalid record");
    await expect(assertT3Closed(f.paths)).rejects.toThrow("requires recovery");
    writeFileSync(marker, JSON.stringify({ ownerPid: process.pid }));
    expect((await assertT3Closed(f.paths)).live).toBe(false);
  });
  it("uses cgroup and main-process ancestry to discover the owning service", async () => {
    const f = fixture();
    const run = vi.fn<SystemctlRunner>(async () => `Id=t3code.service\nMainPID=100\nActiveState=active\nControlGroup=${f.service.controlGroup}\nTriggeredBy=\n`);
    expect(await discoverRuntimeService(101, run, f.procRoot)).toEqual(f.service);
    const unrelated = vi.fn<SystemctlRunner>(async () => `Id=t3code.service\nMainPID=999\nActiveState=active\nControlGroup=${f.service.controlGroup}\nTriggeredBy=\n`);
    expect(await discoverRuntimeService(101, unrelated, f.procRoot)).toBeUndefined();
    const activated = vi.fn<SystemctlRunner>(async () => `Id=t3code.service\nMainPID=100\nActiveState=active\nControlGroup=${f.service.controlGroup}\nTriggeredBy=t3code.socket\n`);
    expect(await discoverRuntimeService(101, activated, f.procRoot)).toBeUndefined();
  });

  it("stops only an idle verified unit and restores it once on exit", async () => {
    const f = fixture();
    const lease = await pauseIdleRuntime(f.paths, f);
    const marker = join(f.paths.stateDir, ".t3-import-maintenance.json");
    expect(existsSync(marker)).toBe(true);
    expect(f.run.mock.calls.filter(([args]) => args.includes("stop"))).toHaveLength(1);
    await lease!.restore(); await lease!.restore();
    expect(f.run.mock.calls.filter(([args]) => args.includes("start"))).toHaveLength(1);
    expect(existsSync(marker)).toBe(false);
  });

  it.each(["busy", "unknown"] as const)("refuses %s activity without stopping", async (activityStatus) => {
    const f = fixture(); f.inspect.mockReset().mockResolvedValue({ ...f.status, activity: { ...f.status.activity, status: activityStatus } });
    await expect(pauseIdleRuntime(f.paths, f)).rejects.toThrow("Automatic pause refused");
    expect(f.run).not.toHaveBeenCalled();
  });

  it("does not stop a reused PID or changed activity", async () => {
    const f = fixture(); f.inspect.mockReset().mockResolvedValueOnce(f.status).mockImplementation(async () => {
      const path = join(f.procRoot, "101", "stat");
      writeFileSync(path, readFileSync(path, "utf8").replace(/42\n$/u, "43\n"));
      return f.status;
    });
    await expect(pauseIdleRuntime(f.paths, f)).rejects.toThrow("identity or activity changed");
    expect(f.run).not.toHaveBeenCalled();
    expect(existsSync(join(f.paths.stateDir, ".t3-import-maintenance.json"))).toBe(false);
  });

  it("restores and refuses writes if work appeared during shutdown", async () => {
    const f = fixture(); f.inspect.mockReset().mockResolvedValueOnce(f.status).mockResolvedValueOnce(f.status)
      .mockResolvedValue({ ...f.stopped, activity: { ...f.stopped.activity, fingerprint: "new-completed-work" } });
    await expect(pauseIdleRuntime(f.paths, f)).rejects.toThrow("activity changed during shutdown");
    expect(f.run.mock.calls.some(([args]) => args.includes("start"))).toBe(true);
    expect(existsSync(join(f.paths.stateDir, ".t3-import-maintenance.json"))).toBe(false);
  });

  it("attempts restoration even when systemd stop reports an error", async () => {
    const f = fixture(); f.run.mockImplementation(async (args) => { if (args.includes("stop")) throw new Error("stop timed out"); return ""; });
    await expect(pauseIdleRuntime(f.paths, f)).rejects.toThrow("stop timed out");
    expect(f.run.mock.calls.some(([args]) => args.includes("start"))).toBe(true);
  });

  it("retains a recovery record when restoration fails", async () => {
    const f = fixture(); const lease = await pauseIdleRuntime(f.paths, f);
    f.run.mockImplementation(async () => { throw new Error("unit start failed"); });
    await expect(lease!.restore()).rejects.toThrow("Recovery: systemctl --user start t3code.service");
    expect(JSON.parse(readFileSync(join(f.paths.stateDir, ".t3-import-maintenance.json"), "utf8")).service.unit).toBe("t3code.service");
  });

  it("leaves an already stopped runtime stopped and preserves existing recovery records", async () => {
    const f = fixture(); f.inspect.mockReset().mockResolvedValue(f.stopped);
    expect(await pauseIdleRuntime(f.paths, f)).toBeUndefined(); expect(f.run).not.toHaveBeenCalled();
    f.inspect.mockReset().mockResolvedValue(f.status);
    const marker = join(f.paths.stateDir, ".t3-import-maintenance.json"); writeFileSync(marker, "existing record");
    await expect(pauseIdleRuntime(f.paths, f)).rejects.toThrow("recovery record already exists");
    f.inspect.mockResolvedValue(f.stopped);
    await expect(pauseIdleRuntime(f.paths, f)).rejects.toThrow("recovery record already exists");
    expect(readFileSync(marker, "utf8")).toBe("existing record"); expect(f.run).not.toHaveBeenCalled();
  });
});
