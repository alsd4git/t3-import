import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "--config", "scripts/demo/vitest.config.ts"]);
run("uv", ["run", "--no-project", "--with", "pillow", "python", "scripts/demo/render.py"]);
