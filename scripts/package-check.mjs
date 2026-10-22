import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const temporaryRoot = await mkdtemp(join(tmpdir(), "t3-import-package-check-"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}):\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function assertIncludes(value, expected, label) {
  if (!value.includes(expected)) throw new Error(`${label} did not include ${JSON.stringify(expected)}:\n${value}`);
}

function runNpm(args) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("Run this check through npm so npm_execpath is available.");
  return run(process.execPath, [npmCli, ...args]);
}

function codexEvent(type, payload, timestamp) {
  return JSON.stringify({ type, payload, timestamp });
}

function codexTurn(index, timestamp) {
  const turnId = `turn-${index}`;
  const time = new Date(Date.parse(timestamp) + index * 60_000).toISOString();
  return [
    codexEvent("event_msg", { type: "task_started", turn_id: turnId, started_at: time }, time),
    codexEvent("response_item", { type: "message", id: `user-${index}`, turn_id: turnId, role: "user", content: [{ type: "input_text", text: `Synthetic prompt ${index}` }] }, time),
    codexEvent("response_item", { type: "message", id: `assistant-${index}`, turn_id: turnId, role: "assistant", content: [{ type: "output_text", text: `Synthetic answer ${index}` }] }, time),
    codexEvent("event_msg", { type: "task_complete", turn_id: turnId }, time),
  ];
}

try {
  const packDirectory = join(temporaryRoot, "pack");
  const installDirectory = join(temporaryRoot, "install");
  await mkdir(packDirectory);
  await mkdir(installDirectory);

  const packOutput = runNpm(["pack", "--json", "--pack-destination", packDirectory]);
  const packResult = JSON.parse(packOutput);
  const packed = Array.isArray(packResult) ? packResult[0] : packResult[metadata.name];
  if (!packed?.filename) throw new Error("npm pack did not report a tarball filename.");
  const tarball = join(packDirectory, packed.filename);

  runNpm(["install", "--ignore-scripts=false", "--no-audit", "--no-fund", "--prefix", installDirectory, tarball]);
  const npmVersion = runNpm(["--version"]).trim();
  if (Number.parseInt(npmVersion, 10) >= 11) {
    // npm 11's install-script approval policy blocks native dependency builds by default.
    runNpm(["install-scripts", "approve", "--prefix", installDirectory, "better-sqlite3"]);
  }
  runNpm(["rebuild", "--prefix", installDirectory, "better-sqlite3"]);
  const installedPackage = join(installDirectory, "node_modules", ...metadata.name.split("/"));
  const cli = join(installedPackage, metadata.bin["t3-import"]);
  const help = run(process.execPath, [cli, "--help"]);
  const version = run(process.execPath, [cli, "--version"]);
  assertIncludes(help, "Import selected conversations", "Installed CLI help");
  assertIncludes(version.trim(), metadata.version, "Installed CLI version");

  const isolatedHome = join(temporaryRoot, "t3-home");
  const codexHome = join(temporaryRoot, "codex-home");
  const workspace = join(temporaryRoot, "workspace");
  const stateDirectory = join(isolatedHome, "userdata");
  const stateDatabase = join(stateDirectory, "statev2.sqlite");
  const fixturePath = join(codexHome, "sessions", "2026", "10", "synthetic.jsonl");
  const ledger = join(temporaryRoot, "ledger");
  await Promise.all([mkdir(stateDirectory, { recursive: true }), mkdir(join(codexHome, "sessions", "2026", "10"), { recursive: true }), mkdir(workspace)]);

  const runtime = await import(pathToFileURL(join(installedPackage, "vendor", "t3-v011", "runtime.mjs")).href);
  const loggerMethods = ["debug", "info", "log", "warn", "error"].map((method) => [method, console[method].bind(console)]);
  for (const [method] of loggerMethods) console[method] = () => {};
  try {
    await runtime.createSchema(stateDatabase);
  } finally {
    for (const [method, original] of loggerMethods) console[method] = original;
  }

  const sessionId = "11111111-1111-4111-8111-111111111111";
  const sessionMeta = codexEvent("session_meta", { id: sessionId, cwd: workspace, timestamp: "2026-10-01T00:00:00.000Z", git_branch: "package-check" }, "2026-10-01T00:00:00.000Z");
  const context = codexEvent("turn_context", { model: "synthetic-model", effort: "medium", cwd: workspace }, "2026-10-01T00:00:00.000Z");
  await writeFile(fixturePath, [sessionMeta, context, ...codexTurn(1, "2026-10-01T00:00:00.000Z")].join("\n") + "\n");

  const commonEnv = {
    T3CODE_HOME: isolatedHome,
    CODEX_HOME: codexHome,
    T3_IMPORT_DATA_DIR: ledger,
  };
  const cliArgs = [
    "--t3-home", isolatedHome,
    "--db", stateDatabase,
    "--no-cache-reset",
  ];
  const importOutput = run(process.execPath, [cli, ...cliArgs, "import", "--source", "codex", "--workspace", workspace, "--thread", sessionId, "--yes", "--non-interactive", "--json"], { env: commonEnv });
  const importResult = JSON.parse(importOutput);
  if (importResult.status !== "imported") throw new Error(`Packed CLI synthetic import returned ${importResult.status}:\n${importOutput}`);

  await writeFile(fixturePath, [sessionMeta, context, ...codexTurn(1, "2026-10-01T00:00:00.000Z"), ...codexTurn(2, "2026-10-01T00:02:00.000Z")].join("\n") + "\n");
  const syncOutput = run(process.execPath, [cli, ...cliArgs, "sync", "--source", "codex", "--workspace", workspace, "--thread", sessionId, "--yes", "--non-interactive", "--summary", "--json"], { env: commonEnv });
  const syncResult = JSON.parse(syncOutput);
  if (syncResult.status !== "synced") throw new Error(`Packed CLI synthetic sync returned ${syncResult.status}:\n${syncOutput}`);
  const repeatedOutput = run(process.execPath, [cli, ...cliArgs, "sync", "--source", "codex", "--workspace", workspace, "--thread", sessionId, "--yes", "--non-interactive", "--summary", "--json"], { env: commonEnv });
  if (JSON.parse(repeatedOutput).status !== "up-to-date") throw new Error(`Repeated packed CLI sync was not idempotent:\n${repeatedOutput}`);

  // Windows cannot unlink a loaded native addon, even after its DB is closed.
  // Let the verification process exit and unload the DLL before removing install/.
  run(process.execPath, [fileURLToPath(new URL("./package-database-check.mjs", import.meta.url)), join(installedPackage, "package.json"), stateDatabase]);

  console.log(`Packed artifact ${metadata.name}@${metadata.version}: install, CLI help/version, and T3 0.1.1 import/sync passed.`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
