import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSchema } from "../../vendor/t3-v010/runtime.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export async function generateV2Schema() {
  const base = join(root, "artifacts/v2-schemas");
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, "synthetic-"));
  const schema = await createSchema(join(directory, "statev2.sqlite"));
  if (Math.max(...schema.migrations.map((row) => row.migration_id)) !== 62) throw new Error("Pinned V2 schema is not migration 62");
  for (const row of schema.migrations) row.created_at = "2026-01-01 00:00:00";
  return { commit: "81493efb71e8e8244f95d3e9f71d8369654ab151", ...schema };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = join(root, "test/fixtures/t3-schemas.json");
  const schemas = JSON.parse(readFileSync(path, "utf8"));
  schemas[62] = await generateV2Schema();
  writeFileSync(path, JSON.stringify(schemas, null, 2) + "\n");
}
