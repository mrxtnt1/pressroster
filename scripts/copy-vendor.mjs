/**
 * Copy runtime assets into public/ so the app never loads code from a CDN:
 *   public/vendor/pdfjs/  pdf.js legacy build, worker, fonts, cmaps, wasm decoders
 *   public/vendor/zxing/  zxing-wasm reader binary
 *   public/samples/       fixture batches for the test page (+ manifest.json)
 * Runs automatically before `dev` and `build`. Output is git-ignored.
 */
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
const pub = path.join(root, "public");
const pdfjs = path.dirname(require.resolve("pdfjs-dist/package.json"));

await rm(path.join(pub, "vendor"), { recursive: true, force: true });
await mkdir(path.join(pub, "vendor", "pdfjs"), { recursive: true });
for (const file of ["pdf.min.mjs", "pdf.worker.min.mjs"]) {
  await cp(path.join(pdfjs, "legacy", "build", file), path.join(pub, "vendor", "pdfjs", file));
}
for (const dir of ["standard_fonts", "cmaps", "wasm", "iccs"]) {
  await cp(path.join(pdfjs, dir), path.join(pub, "vendor", "pdfjs", dir), { recursive: true });
}
await mkdir(path.join(pub, "vendor", "zxing"), { recursive: true });
await cp(require.resolve("zxing-wasm/reader/zxing_reader.wasm"), path.join(pub, "vendor", "zxing", "zxing_reader.wasm"));

await rm(path.join(pub, "samples"), { recursive: true, force: true });
const batches = path.join(root, "fixtures", "batches");
const manifest = {};
for (const name of (await readdir(batches)).sort()) {
  const files = (await readdir(path.join(batches, name))).filter((f) => !f.startsWith(".")).sort();
  await cp(path.join(batches, name), path.join(pub, "samples", name), { recursive: true });
  manifest[name] = { csv: "order.csv", files: files.filter((f) => f !== "order.csv") };
}
await writeFile(path.join(pub, "samples", "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`vendor assets copied (pdfjs-dist ${require("pdfjs-dist/package.json").version}); ${Object.keys(manifest).length} sample batches`);
