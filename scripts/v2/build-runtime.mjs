import { build } from "esbuild";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, mkdirSync, mkdtempSync, copyFileSync, writeFileSync } from "node:fs";
import { resolve, relative, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { releases } from "./releases.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const release = process.argv[2] ?? "0.1.0";
const profile = releases[release];
if (!profile) throw new Error(`Unknown pinned release: ${release}`);
const { commit, archiveSha256 } = profile;
const vendor = resolve(root, "vendor", profile.directory);
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
mkdirSync(vendor, { recursive: true });
const result = await build({
  entryPoints: [resolve(root, "scripts/v2/runtime-entry.mjs")],
  outfile: resolve(vendor, "runtime.mjs"),
  platform: "node", target: "node22.21", format: "esm", bundle: true,
  external: [profile.effectPackage, `${profile.effectPackage}/*`],
  alias: { effect: profile.effectPackage }, write: false, metafile: true,
  define: { __T3_REFERENCE__: JSON.stringify(commit) },
  absWorkingDir: root,
  nodePaths: [resolve(root, "scripts/v2/dependencies/node_modules")],
  banner: { js: `// Generated from T3 Code v${release}, commit ${commit}. MIT. See LICENSE.\nimport { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);` },
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
writeFileSync(resolve(vendor, "runtime.mjs"), result.outputFiles[0].text.replaceAll(relative(root, source), `t3code-v${release}`));
copyFileSync(resolve(source, "LICENSE"), resolve(vendor, "LICENSE"));
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
writeFileSync(resolve(vendor, "THIRD-PARTY-NOTICES.txt"), [...packages].sort(([a], [b]) => a.localeCompare(b)).map(([name, license]) => `${name}\n${license}`).join("\n\n"));
writeFileSync(resolve(vendor, "reference.json"), JSON.stringify({ tag: `v${release}`, commit, archiveSha256, effect: profile.effect }, null, 2) + "\n");
const { createSchema } = await import(pathToFileURL(resolve(vendor, "runtime.mjs")).href);
const schemaDirectory = mkdtempSync(join(cache, "schema-"));
const schemaPath = join(schemaDirectory, "statev2.sqlite");
await createSchema(schemaPath);
const { DatabaseSync } = await import("node:sqlite");
const db = new DatabaseSync(schemaPath, { readOnly: true });
try {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const columns = Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`PRAGMA table_info(${name})`).all().map(({ name }) => name)]));
  writeFileSync(resolve(vendor, "schema-columns.json"), JSON.stringify(columns, null, 2) + "\n");
} finally { db.close(); }
