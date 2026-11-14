import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createNodeRuntime } from "@/lib/check/runtime-node";
import type { BatchFile } from "@/lib/check";

export const FIXTURES = path.resolve(import.meta.dirname, "..", "fixtures");
export const runtime = createNodeRuntime();

export async function fixtureBytes(rel: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path.join(FIXTURES, rel)));
}

export function memoryFile(name: string, bytes: Uint8Array): BatchFile {
  return { name, size: bytes.byteLength, read: async () => bytes };
}

/** Load `fixtures/batches/<name>`: order.csv plus every other file. */
export async function loadBatch(name: string): Promise<{ csv: Uint8Array; files: BatchFile[] }> {
  const dir = path.join(FIXTURES, "batches", name);
  const names = (await readdir(dir)).filter((n) => !n.startsWith(".")).sort();
  const csv = await fixtureBytes(`batches/${name}/order.csv`);
  const files = await Promise.all(
    names
      .filter((n) => n !== "order.csv")
      .map(async (n) => {
        const p = path.join(dir, n);
        return { name: n, size: (await stat(p)).size, read: async () => new Uint8Array(await readFile(p)) };
      }),
  );
  return { csv, files };
}
