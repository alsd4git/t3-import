// Linux-only integration check. Creates and removes its own user service;
// never uses the real T3 home, provider home, or t3code.service.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

if (process.platform !== "linux") throw new Error("This check requires Linux and a user systemd manager.");
const root = resolve(process.argv[2] ?? ".");
const require = createRequire(join(root, "package.json"));
const Database = require("better-sqlite3");
const temporary = await mkdtemp(join(tmpdir(), "t3-import-service-check-"));
const home = join(temporary, "t3");
const state = join(home, "userdata");
const database = join(state, "statev2.sqlite");
const codex = join(temporary, "codex");
const workspace = join(temporary, "workspace");
const unit = `t3-import-check-${process.pid}-${Date.now()}.service`;
const unitDirectory = join(homedir(), ".config/systemd/user");
const unitPath = join(unitDirectory, unit);
let installed = false;
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 120_000, ...options });
  if (result.error) throw result.error;
  return result;
}
function systemctl(...args) {
  const result = run("systemctl", ["--user", "--no-ask-password", ...args]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
const env = { ...process.env, T3CODE_HOME: home, CODEX_HOME: codex, T3_IMPORT_DATA_DIR: join(temporary, "ledger") };
const cliPath = join(root, "dist/cli.js");
function cli(args, expected = 0) {
  const result = run(process.execPath, [cliPath, "--t3-home", home, "--db", database, "--no-cache-reset", "--json", ...args], { env });
  assert.equal(result.status, expected, result.stderr + result.stdout);
  return JSON.parse(result.stdout);
}
async function status() {
  for (let attempt = 0; attempt < 30; attempt++) {
    const runtime = cli(["runtime", "status"]).runtime;
    if (runtime.live && runtime.service?.unit === unit) return runtime;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("Synthetic runtime did not become ready.");
}
async function cancelTui(signal) {
  const command = [process.execPath, cliPath, "--t3-home", home, "--db", database, "--manage-runtime"].map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(" ");
  const child = spawn("script", ["-q", "-e", "-c", `stty cols 120 rows 40; exec ${command}`, "/dev/null"], { env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  let cancelled = false;
  const timeout = setTimeout(() => child.kill("SIGTERM"), 20_000);
  const cancel = async (chunk) => {
    output += chunk;
    if (cancelled || !output.includes("Choose a source")) return;
    cancelled = true;
    if (signal === "SIGTERM") {
      const marker = JSON.parse(await readFile(join(state, ".t3-import-maintenance.json"), "utf8"));
      process.kill(marker.ownerPid, signal);
    } else child.stdin.write(signal === "Ctrl+C" ? "\u0003" : "q");
  };
  child.stdout.on("data", (chunk) => { void cancel(chunk).catch(() => child.kill("SIGTERM")); });
  child.stderr.on("data", (chunk) => { output += chunk; });
  try {
    const code = await new Promise((done, reject) => { child.once("exit", done); child.once("error", reject); });
    assert(cancelled, `TUI did not reach cancellation: ${output}`);
    assert.equal(code, signal === "SIGTERM" ? 143 : 0, output);
  } finally { clearTimeout(timeout); child.stdin.end(); }
}
try {
  await Promise.all([mkdir(state, { recursive: true }), mkdir(codex), mkdir(workspace), mkdir(unitDirectory, { recursive: true })]);
  const runtime = await import(pathToFileURL(join(root, "vendor/t3-v011/runtime.mjs")).href);
  await runtime.createSchema(database);
  const serverPath = join(temporary, "server.mjs");
  await writeFile(serverPath, `
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { writeFileSync, unlinkSync } from 'node:fs';
const require = createRequire(${JSON.stringify(join(root, "package.json"))});
const db = new (require('better-sqlite3'))(${JSON.stringify(database)});
db.pragma('journal_mode = WAL');
const marker = ${JSON.stringify(join(state, "server-runtime.json"))};
const server = createServer((_, response) => response.end('synthetic T3'));
server.listen(0, '127.0.0.1', () => writeFileSync(marker, JSON.stringify({version:1,pid:process.pid,origin:'http://127.0.0.1:'+server.address().port})));
process.on('SIGTERM', () => server.close(() => { db.close(); unlinkSync(marker); process.exit(0); }));
`);
  // Generated paths contain no whitespace or systemd specifiers.
  for (const path of [process.execPath, serverPath]) assert(!/[\s%"\\]/u.test(path));
  await writeFile(unitPath, `[Unit]\nDescription=Isolated t3-import integration check\n[Service]\nExecStart=${process.execPath} ${serverPath}\nRestart=always\nRestartSec=1\n`, { flag: "wx" });
  installed = true;
  systemctl("daemon-reload");
  systemctl("start", unit);
  const before = await status();
  assert.equal(before.activity.status, "idle");
  const fixtureDirectory = join(codex, "sessions/2026/10");
  await mkdir(fixtureDirectory, { recursive: true });
  const id = "11111111-1111-4111-8111-111111111111";
  const event = (type, payload) => JSON.stringify({ type, payload, timestamp: "2026-10-01T00:00:00.000Z" });
  await writeFile(join(fixtureDirectory, "synthetic.jsonl"), [
    event("session_meta", { id, cwd: workspace, timestamp: "2026-10-01T00:00:00.000Z" }),
    event("turn_context", { model: "synthetic", effort: "medium", cwd: workspace }),
    event("event_msg", { type: "task_started", turn_id: "turn-1" }),
    event("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Synthetic prompt" }] }),
    event("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Synthetic answer" }] }),
    event("event_msg", { type: "task_complete", turn_id: "turn-1" }),
  ].join("\n") + "\n");
  const args = ["import", "--source", "codex", "--workspace", workspace, "--thread", id, "--yes", "--non-interactive"];
  assert.equal(cli(["--manage-runtime", ...args]).status, "imported");
  const after = await status();
  assert.notEqual(after.pid, before.pid);
  assert.equal(after.activity.status, "idle");
  const failed = cli(["--manage-runtime", ...args, "--target-project", "missing-project"], 2);
  assert.equal(failed.status, "error");
  const restored = await status();
  assert.notEqual(restored.pid, after.pid);
  await cancelTui();
  const cancelled = await status();
  assert.notEqual(cancelled.pid, restored.pid);
  await cancelTui("Ctrl+C");
  const ctrlC = await status();
  assert.notEqual(ctrlC.pid, cancelled.pid);
  await cancelTui("SIGTERM");
  const terminated = await status();
  assert.notEqual(terminated.pid, ctrlC.pid);
  const db = new Database(database);
  db.prepare("INSERT INTO orchestration_v2_projection_runs (run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES ('busy-fixture','fixture',1,'codex','running','2026-10-01T00:00:00Z','{}')").run();
  assert.equal(cli(["runtime", "status"]).runtime.activity.status, "busy");
  assert.equal(cli(["--manage-runtime", ...args], 4).status, "error");
  assert.equal((await status()).pid, terminated.pid, "Busy service must not be stopped");
  db.close();
  console.log("Isolated systemd check passed: ownership, idle pause/import/restore, error restoration, TUI cancellation, Ctrl+C, SIGTERM, and busy refusal.");
} finally {
  if (installed) {
    systemctl("stop", unit);
    await rm(unitPath);
    systemctl("daemon-reload");
    // A failed synthetic start can leave an unloaded failure record.
    run("systemctl", ["--user", "reset-failed", unit]);
  }
  await rm(temporary, { recursive: true, force: true });
}
