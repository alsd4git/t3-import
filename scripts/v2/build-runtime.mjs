import { build } from "esbuild";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, mkdirSync, mkdtempSync, copyFileSync, writeFileSync } from "node:fs";
import { resolve, relative, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const commit = "81493efb71e8e8244f95d3e9f71d8369654ab151";
const archiveSha256 = "80336b0fef0ed4860474ffade2ffdb5e1e87975e5c19447402eb38304638a1ad";
const cache = resolve(root, "artifacts/v2-runtime");
mkdirSync(cache, { recursive: true });
const archive = process.env.T3_V2_SOURCE_ARCHIVE ?? join(cache, `${commit}.tar.gz`);
if (!existsSync(archive)) {
  const response = await fetch(`https://api.github.com/repos/pingdotgg/t3code/tarball/${commit}`);
  if (!response.ok) throw new Error(`Pinned source download failed: HTTP ${response.status}`);
  writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
}
if (createHash("sha256").update(readFileSync(archive)).digest("hex") !== archiveSha256) throw new Error("Pinned T3 source archive checksum mismatch; refusing to bundle it.");
const source = mkdtempSync(join(cache, "source-"));
execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", source]);
execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: resolve(root, "scripts/v2/dependencies"), stdio: "inherit" });
mkdirSync(resolve(root, "vendor/t3-v010"), { recursive: true });
const result = await build({
  entryPoints: [resolve(root, "scripts/v2/runtime-entry.mjs")],
  outfile: resolve(root, "vendor/t3-v010/runtime.mjs"),
  platform: "node", target: "node22.21", format: "esm", bundle: true,
  external: ["effect", "effect/*"], write: false, metafile: true,
  absWorkingDir: root,
  nodePaths: [resolve(root, "scripts/v2/dependencies/node_modules")],
  banner: { js: "// Generated from T3 Code v0.1.0, commit 81493efb71e8e8244f95d3e9f71d8369654ab151. MIT. See LICENSE.\nimport { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  plugins: [{ name: "pinned-t3-workspace", setup(build) {
    build.onResolve({ filter: /artifacts\/t3-v010\/apps\/server\/src\// }, ({ path }) => {
      return { path: resolve(source, "apps/server/src", path.split("apps/server/src/")[1]) };
    });
    build.onResolve({ filter: /^@t3tools\// }, ({ path }) => {
      const [name, ...subpath] = path.slice("@t3tools/".length).split("/");
      const dir = resolve(source, "packages", name);
      const manifest = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8"));
      const entry = manifest.exports[subpath.length ? `./${subpath.join("/")}` : "."];
      const target = typeof entry === "string" ? entry : entry?.import ?? entry?.default;
      if (!target) throw new Error(`No pinned export: ${path}`);
      return { path: resolve(dir, target) };
    });
  } }],
});
writeFileSync(resolve(root, "vendor/t3-v010/runtime.mjs"), result.outputFiles[0].text.replaceAll(relative(root, source), "t3code-v0.1.0"));
copyFileSync(resolve(source, "LICENSE"), resolve(root, "vendor/t3-v010/LICENSE"));
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  if (!input.includes("node_modules/")) continue;
  let dir = dirname(resolve(root, input));
  let manifest;
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) {
      manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (manifest.name && manifest.version) break;
    }
    dir = dirname(dir);
  }
  if (!manifest?.name) throw new Error(`Missing dependency manifest: ${input}`);
  const key = `${manifest.name}@${manifest.version}`;
  const licenses = readdirSync(dir).filter((name) => /^(licen[sc]e|copying|notice)(\.|$)/i.test(name));
  if (!licenses.length) throw new Error(`Missing license text for bundled package ${key}`);
  packages.set(key, licenses.sort().map((name) => readFileSync(join(dir, name), "utf8")).join("\n"));
}
writeFileSync(resolve(root, "vendor/t3-v010/THIRD-PARTY-NOTICES.txt"), [...packages].sort(([a], [b]) => a.localeCompare(b)).map(([name, license]) => `${name}\n${license}`).join("\n\n"));
writeFileSync(resolve(root, "vendor/t3-v010/reference.json"), JSON.stringify({ tag: "v0.1.0", commit, archiveSha256, effect: "4.0.4" }, null, 2) + "\n");
const { createSchema } = await import(pathToFileURL(resolve(root, "vendor/t3-v010/runtime.mjs")).href);
const schemaDirectory = mkdtempSync(join(cache, "schema-"));
const schemaPath = join(schemaDirectory, "statev2.sqlite");
await createSchema(schemaPath);
const { DatabaseSync } = await import("node:sqlite");
const db = new DatabaseSync(schemaPath, { readOnly: true });
try {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const columns = Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`PRAGMA table_info(${name})`).all().map(({ name }) => name)]));
  writeFileSync(resolve(root, "vendor/t3-v010/schema-columns.json"), JSON.stringify(columns, null, 2) + "\n");
} finally { db.close(); }
