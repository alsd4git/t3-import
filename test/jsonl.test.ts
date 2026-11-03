import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
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

  it("settles early cancellation in a standalone process with compressed input backpressure", () => {
    const path = join(directory(), "session.jsonl.zst");
    const noise = Array.from({ length: 4096 }, (_, index) => createHash("sha256").update(String(index)).digest("hex")).join("");
    writeFileSync(path, zstdCompressSync(Buffer.from('{"header":true}\n' + noise + "x".repeat(300_000))));
    const moduleUrl = new URL("../src/core/jsonl.ts", import.meta.url).href;
    const script = `import {readJsonlLines} from ${JSON.stringify(moduleUrl)};
      for await (const line of readJsonlLines(process.argv[1])) { break; }
      console.log("closed");`;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, path], {
      encoding: "utf8", timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("closed");
    expect(result.stderr).not.toContain("unsettled");
  });
});
