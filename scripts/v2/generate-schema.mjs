import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
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
  const generated = new Map();
  for (const [release, profile] of Object.entries(releases)) {
    const schema = await generateV2Schema(release);
    const previous = generated.get(profile.migration);
    if (previous && (!isDeepStrictEqual(previous.ddl, schema.ddl) || !isDeepStrictEqual(previous.migrations, schema.migrations))) {
      throw new Error(`Pinned releases disagree on schema migration ${profile.migration}; a shared profile is unsafe.`);
    }
    generated.set(profile.migration, schema);
    schemas[profile.migration] = schema;
  }
  writeFileSync(path, JSON.stringify(schemas, null, 2) + "\n");
}
