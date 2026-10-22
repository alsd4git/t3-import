import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { TargetPaths } from "../core/types.js";
import { safetyError } from "../core/errors.js";
import { inspectRuntime, runtimeMaintenancePath, type RuntimeState } from "./schema.js";
import { inspectRuntimeActivity, runtimeActivityText, type RuntimeActivity } from "./runtimeActivity.js";

const execute = promisify(execFile);
export interface RuntimeService {
  scope: "user" | "system";
  unit: string;
  mainPid: number;
  controlGroup: string;
}
export interface RuntimeStatus extends RuntimeState {
  activity: RuntimeActivity;
  service?: RuntimeService;
  managementUnavailable?: string;
}
type ServiceProperties = Record<string, string>;
export type SystemctlRunner = (args: string[]) => Promise<string>;
async function systemctl(args: string[]): Promise<string> {
  return (await execute("systemctl", args, { timeout: args.includes("show") ? 3_000 : 120_000, maxBuffer: 64 * 1024, windowsHide: true })).stdout;
}
function serviceArgs(service: Pick<RuntimeService, "scope" | "unit">, action: string): string[] {
  return [...(service.scope === "user" ? ["--user"] : []), "--no-ask-password", action, service.unit];
}
async function properties(service: Pick<RuntimeService, "scope" | "unit">, run: SystemctlRunner): Promise<ServiceProperties> {
  const output = await run([...serviceArgs(service, "show"), "--property=Id,MainPID,ActiveState,SubState,ControlGroup,TriggeredBy"]);
  return Object.fromEntries(output.trim().split("\n").map((line) => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}
function cgroup(pid: number, procRoot: string): string {
  return readFileSync(join(procRoot, String(pid), "cgroup"), "utf8");
}
function processIdentity(pid: number, procRoot: string): string {
  const value = readFileSync(join(procRoot, String(pid), "stat"), "utf8");
  // /proc stat field 2 can contain spaces and parentheses; starttime is field 22.
  const start = value.slice(value.lastIndexOf(")") + 2).trim().split(/\s+/u)[19];
  if (!start || !/^\d+$/u.test(start)) throw safetyError("Cannot verify the T3 process start time.");
  return `${pid}:${start}`;
}

/** Identify the unit that actually owns this runtime, never infer it from its name. */
export async function discoverRuntimeService(
  pid: number,
  run: SystemctlRunner = systemctl,
  procRoot = "/proc",
): Promise<RuntimeService | undefined> {
  const groups = cgroup(pid, procRoot);
  const units = [...groups.matchAll(/(?:^|\/)([a-zA-Z0-9][a-zA-Z0-9_.@:\\-]*\.service)(?=\/|$)/gmu)]
    .map((match) => match[1]!).filter((name) => !/^user@\d+\.service$/u.test(name));
  const unit = [...new Set(units)].at(-1);
  if (!unit) return undefined;
  for (const scope of ["user", "system"] as const) {
    try {
      if (scope === "user" && statSync(join(procRoot, String(pid))).uid !== process.getuid?.()) continue;
      const data = await properties({ scope, unit }, run);
      const mainPid = Number(data.MainPID);
      if (data.Id !== unit || data.ActiveState !== "active" || !mainPid || !data.ControlGroup || data.TriggeredBy) continue;
      if (!groups.split("\n").some((line) => {
        const path = line.slice(line.indexOf(":", line.indexOf(":") + 1) + 1);
        return path === data.ControlGroup || path.startsWith(`${data.ControlGroup}/`);
      })) continue;
      // A broad login/session unit is not sufficient: its main process must own T3.
      let ancestor = pid;
      const visited = new Set<number>();
      while (ancestor > 0 && !visited.has(ancestor)) {
        if (ancestor === mainPid) return { scope, unit, mainPid, controlGroup: data.ControlGroup };
        visited.add(ancestor);
        const status = readFileSync(join(procRoot, String(ancestor), "status"), "utf8");
        ancestor = Number(/^PPid:\s*(\d+)/mu.exec(status)?.[1] ?? 0);
      }
    } catch {
      // A different manager scope may own the process; never fall back to kill().
    }
  }
  return undefined;
}

export async function inspectRuntimeStatus(paths: TargetPaths): Promise<RuntimeStatus> {
  const runtime = await inspectRuntime(paths);
  const activity = inspectRuntimeActivity(paths);
  if (!runtime.live) return { ...runtime, activity };
  if (process.platform !== "linux" || !runtime.pid) {
    return { ...runtime, activity, managementUnavailable: "Automatic pause requires a verified Linux systemd service. Close this runtime manually." };
  }
  try {
    const database = realpathSync(paths.dbPath);
    const ownsDatabase = readdirSync(`/proc/${runtime.pid}/fd`).some((fd) => {
      try { return realpathSync(`/proc/${runtime.pid}/fd/${fd}`) === database; }
      catch { return false; }
    });
    if (!ownsDatabase) return { ...runtime, activity, managementUnavailable: "The recorded PID does not hold this T3 database open. Automatic pause refused." };
    const service = await discoverRuntimeService(runtime.pid);
    return service ? { ...runtime, activity, service }
      : { ...runtime, activity, managementUnavailable: "No unambiguously owned systemd service without activation triggers was found. Close T3 manually." };
  } catch {
    return { ...runtime, activity, managementUnavailable: "Cannot verify the runtime's service ownership. Close T3 manually." };
  }
}

export interface RuntimeMaintenance {
  service: RuntimeService;
  restore(): Promise<void>;
}
interface MaintenanceOptions {
  inspect?: (paths: TargetPaths) => Promise<RuntimeStatus>;
  run?: SystemctlRunner;
  procRoot?: string;
  ready?: (paths: TargetPaths, service: RuntimeService) => Promise<boolean>;
  timeoutMs?: number;
}
function recoveryCommand(service: RuntimeService): string {
  return `systemctl ${service.scope === "user" ? "--user " : ""}start ${service.unit}`;
}
async function runtimeReady(paths: TargetPaths, service: RuntimeService): Promise<boolean> {
  const runtime = await inspectRuntime(paths);
  if (!runtime.live || !runtime.pid || !runtime.origin) return false;
  const owner = await discoverRuntimeService(runtime.pid);
  if (owner?.unit !== service.unit || owner.scope !== service.scope) return false;
  const origin = new URL(runtime.origin);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) || origin.username || origin.password) return false;
  try { return (await fetch(origin, { signal: AbortSignal.timeout(700) })).status > 0; }
  catch { return false; }
}

/** Explicit maintenance only. Restore via the same unit; never replay argv or env. */
export async function pauseIdleRuntime(paths: TargetPaths, options: MaintenanceOptions = {}): Promise<RuntimeMaintenance | undefined> {
  const inspect = options.inspect ?? inspectRuntimeStatus;
  const run = options.run ?? systemctl;
  const procRoot = options.procRoot ?? "/proc";
  const marker = runtimeMaintenancePath(paths);
  if (existsSync(marker)) throw safetyError(`A maintenance recovery record already exists at ${marker}. Review it before continuing; do not overwrite it.`);
  const before = await inspect(paths);
  if (!before.live) return undefined;
  if (before.activity.status !== "idle") throw safetyError(`${runtimeActivityText(before.activity)} Automatic pause refused.`);
  if (!before.service || !before.pid) throw safetyError(before.managementUnavailable ?? "Cannot verify the runtime's service.");
  const service = before.service;
  const identity = processIdentity(before.pid, procRoot);
  writeFileSync(marker, JSON.stringify({ version: 1, ownerPid: process.pid, startedAt: new Date().toISOString(), service, recoveryCommand: recoveryCommand(service) }) + "\n", { flag: "wx", mode: 0o600 });
  let stopAttempted = false;
  let restoration: Promise<void> | undefined;
  const maintenance: RuntimeMaintenance = {
    service,
    restore() {
      restoration ??= (async () => {
        try {
          await run(serviceArgs(service, "start"));
          const deadline = Date.now() + (options.timeoutMs ?? 30_000);
          while (Date.now() < deadline) {
            if (await (options.ready ?? runtimeReady)(paths, service)) {
              unlinkSync(marker);
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 150));
          }
          throw new Error("The service did not become ready before the timeout.");
        } catch (cause) {
          throw safetyError(`Unable to restore ${service.unit}: ${cause instanceof Error ? cause.message : String(cause)} Recovery: ${recoveryCommand(service)}. Record retained at ${marker}.`);
        }
      })();
      return restoration;
    },
  };
  try {
    const current = await inspect(paths);
    if (!current.live || current.pid !== before.pid || processIdentity(before.pid, procRoot) !== identity
      || current.service?.unit !== service.unit || current.service.scope !== service.scope
      || current.service.mainPid !== service.mainPid || current.service.controlGroup !== service.controlGroup
      || current.activity.status !== "idle" || current.activity.fingerprint !== before.activity.fingerprint) {
      throw safetyError("Runtime identity or activity changed before stopping. No stop was attempted; retry inspection.");
    }
    stopAttempted = true;
    await run(serviceArgs(service, "stop"));
    const stopped = await properties(service, run);
    if (stopped.ActiveState !== "inactive" || Number(stopped.MainPID) !== 0) throw safetyError("The service has not fully stopped. Database writes are refused.");
    const after = await inspect(paths);
    if (after.live || after.activity.status !== "idle" || after.activity.fingerprint !== before.activity.fingerprint) {
      throw safetyError("Runtime activity changed during shutdown or T3 is still reachable. Database writes are refused.");
    }
    return maintenance;
  } catch (cause) {
    if (stopAttempted) {
      try { await maintenance.restore(); }
      catch (restoreError) { throw safetyError(`${cause instanceof Error ? cause.message : String(cause)} ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`); }
    } else unlinkSync(marker);
    throw cause;
  }
}
