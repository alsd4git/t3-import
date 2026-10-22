import { createReadStream, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
import { sha256 } from "./util.js";

export interface JsonlSnapshot {
  rows: unknown[];
  fingerprint: string;
  mtimeMs: number;
  size: number;
}

/** Stream decoded lines without extracting or modifying provider files. */
export async function* readJsonlLines(path: string): AsyncGenerator<string> {
  const file = createReadStream(path);
  const decompressor = path.endsWith(".jsonl.zst") ? createZstdDecompress() : undefined;
  const stream = decompressor ?? file;
  // Attach the rejection handler before consuming output. Both input failures
  // and decoder finalization errors must reject reads, including truncated frames.
  const completion = decompressor ? pipeline(file, decompressor).then(() => undefined, (error: unknown) => error) : Promise.resolve(undefined);
  const decoder = new StringDecoder("utf8");
  let pending = "";
  try {
    for await (const chunk of stream) {
      pending += decoder.write(chunk);
      let start = 0;
      let end: number;
      while ((end = pending.indexOf("\n", start)) !== -1) {
        yield pending.slice(start, end).replace(/\r$/u, "");
        start = end + 1;
      }
      pending = pending.slice(start);
    }
    const failure = await completion;
    if (failure) throw failure;
    pending += decoder.end();
    if (pending) yield pending.replace(/\r$/u, "");
  } finally {
    stream.destroy();
    file.destroy();
    await completion;
  }
}

async function readOnce(path: string): Promise<JsonlSnapshot> {
  const before = statSync(path);
  const rows: unknown[] = [];
  const hashParts: string[] = [];
  for await (const line of readJsonlLines(path)) {
    if (!line.trim()) continue;
    hashParts.push(line, "\n");
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`Invalid JSONL in ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const after = statSync(path);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error("SOURCE_CHANGED_DURING_READ");
  }
  return { rows, fingerprint: sha256(hashParts.join("")), mtimeMs: after.mtimeMs, size: after.size };
}

export async function readStableJsonl(path: string): Promise<JsonlSnapshot> {
  try {
    return await readOnce(path);
  } catch (error) {
    if (error instanceof Error && error.message === "SOURCE_CHANGED_DURING_READ") {
      return readOnce(path);
    }
    throw error;
  }
}
