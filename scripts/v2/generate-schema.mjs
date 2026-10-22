import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releases } from "./releases.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export async function generateV2Schema(release = "0.1.0") {
  const profile = releases[release];
  if (!profile) throw new Error(`Unknown pinned release: ${release}`);
  const { createSchema } = await import(`../../vendor/${profile.directory}/runtime.mjs`);
  const base = join(root, "artifacts/v2-schemas");
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, "synthetic-"));
  const schema = await createSchema(join(directory, "statev2.sqlite"));
  if (Math.max(...schema.migrations.map((row) => row.migration_id)) !== profile.migration) throw new Error(`Pinned V2 schema is not migration ${profile.migration}`);
  for (const row of schema.migrations) row.created_at = "2026-01-01 00:00:00";
  return { commit: profile.commit, ...schema };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = join(root, "test/fixtures/t3-schemas.json");
  const schemas = JSON.parse(readFileSync(path, "utf8"));
  for (const [release, profile] of Object.entries(releases)) schemas[profile.migration] = await generateV2Schema(release);
  writeFileSync(path, JSON.stringify(schemas, null, 2) + "\n");
}
