import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { readJsonlLines, readStableJsonl } from "../src/core/jsonl.js";

const roots: string[] = [];
function directory(): string {
  const root = mkdtempSync(join(tmpdir(), "t3-jsonl-")); roots.push(root); return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("compressed JSONL", () => {
  it("decodes Unicode and CRLF with the same content fingerprint as plain JSONL", async () => {
    const root = directory();
    const path = join(root, "session.jsonl");
    const rows = [{ text: "è🧭".repeat(40_000) }, { value: 2 }];
    const contents = rows.map((row) => JSON.stringify(row)).join("\r\n\r\n");
    writeFileSync(path, contents);
    writeFileSync(path + ".zst", zstdCompressSync(Buffer.from(contents)));
    const plain = await readStableJsonl(path);
    const compressed = await readStableJsonl(path + ".zst");
    expect(compressed.rows).toEqual(rows);
    expect(compressed.fingerprint).toBe(plain.fingerprint);
    expect(compressed.size).toBeLessThan(plain.size);
  });

  it("rejects corrupt, truncated and malformed data instead of returning a partial snapshot", async () => {
    const path = join(directory(), "session.jsonl.zst");
    writeFileSync(path, "not a Zstandard frame");
    await expect(readStableJsonl(path)).rejects.toThrow();
    const compressed = zstdCompressSync(Buffer.from('{"text":"test"}\n'));
    writeFileSync(path, compressed.subarray(0, compressed.length - 3));
    await expect(readStableJsonl(path)).rejects.toThrow();
    writeFileSync(path, zstdCompressSync(Buffer.from('{"valid":true}\nnot json\n')));
    await expect(readStableJsonl(path)).rejects.toThrow("Invalid JSONL");
    await expect(readStableJsonl(join(directory(), "missing.jsonl.zst"))).rejects.toThrow();
  });

  it("closes the decompression stream when header discovery stops early", async () => {
    const path = join(directory(), "session.jsonl.zst");
    writeFileSync(path, zstdCompressSync(Buffer.from('{"header":true}\n' + '{"large":"' + "x".repeat(1_000_000) + '"}\n')));
    for await (const line of readJsonlLines(path)) {
      expect(JSON.parse(line)).toEqual({ header: true });
      break;
    }
  });
});
