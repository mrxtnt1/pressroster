/**
 * Run the PressRoster checker from the command line (same engine as the app).
 *
 *   npm run check -- fixtures/batches/mixed            # folder with order.csv + PDFs
 *   npm run check -- --csv order.csv a.pdf b.pdf       # explicit files
 *   npm run check -- fixtures/batches/mixed --json     # machine-readable report
 *
 * Exit code: 0 all pass · 1 mismatches or needs review · 2 invalid CSV/usage.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { checkBatch, formatCsvError, type BatchFile, type FindingStatus } from "../src/lib/check";
import { createNodeRuntime } from "../src/lib/check/runtime-node";

const args = process.argv.slice(2);
const json = args.includes("--json");
const positional = args.filter((a) => a !== "--json");

let csvPath: string | undefined;
let filePaths: string[] = [];
const csvFlag = positional.indexOf("--csv");
if (csvFlag >= 0) {
  csvPath = positional[csvFlag + 1];
  filePaths = positional.filter((_, i) => i !== csvFlag && i !== csvFlag + 1);
} else if (positional.length === 1 && (await stat(positional[0])).isDirectory()) {
  const dir = positional[0];
  const names = (await readdir(dir)).filter((n) => !n.startsWith("."));
  csvPath = path.join(dir, names.find((n) => n.toLowerCase() === "order.csv") ?? "order.csv");
  filePaths = names.filter((n) => !n.toLowerCase().endsWith(".csv")).map((n) => path.join(dir, n));
}
if (!csvPath) {
  console.error("Usage: npm run check -- <folder> | --csv order.csv file.pdf …  [--json]");
  process.exit(2);
}

const files: BatchFile[] = await Promise.all(
  filePaths.map(async (p) => ({
    name: path.basename(p),
    size: (await stat(p)).size,
    read: async () => new Uint8Array(await readFile(p)),
  })),
);

const started = Date.now();
const result = await checkBatch({ csv: new Uint8Array(await readFile(csvPath)), files }, createNodeRuntime(), {
  onProgress: ({ done, total, filename }) => {
    if (!json && filename) process.stderr.write(`  checking ${done + 1}/${total} ${filename}\n`);
  },
});

if (!result.ok) {
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`\nThe order CSV has ${result.csvErrors.length} problem(s); nothing was checked:\n`);
    for (const e of result.csvErrors) console.log(`  • ${formatCsvError(e)}`);
  }
  process.exit(2);
}

const { report } = result;
if (json) {
  // Inspections carry QR corner data; keep the CLI output to findings.
  const locations = report.locations.map((l) => ({
    locationId: l.locationId,
    row: l.row,
    status: l.status,
    files: l.files.map((f) => f.filename),
    findings: l.findings,
  }));
  console.log(JSON.stringify({ ...report, locations }, null, 2));
} else {
  const label: Record<FindingStatus, string> = { pass: "PASS", mismatch: "MISMATCH", needs_review: "REVIEW" };
  console.log("");
  for (const location of [...report.locations, ...report.unexpectedFiles.map((f) => ({ locationId: "(no match)", status: f.status, findings: f.findings }))]) {
    console.log(`${label[location.status].padEnd(9)} ${location.locationId}`);
    for (const f of location.findings) {
      if (f.status === "pass") continue;
      console.log(`  ${label[f.status].padEnd(9)} ${f.check.padEnd(10)} ${f.filename ?? "—"}`);
      console.log(`            ${f.reason}`);
      if (f.expected) console.log(`            expected: ${f.expected}`);
      if (f.actual) console.log(`            actual:   ${f.actual}`);
    }
  }
  const s = report.summary;
  console.log(
    `\n${s.locations} locations · ${s.pass} pass · ${s.mismatch} mismatch · ${s.needsReview} needs review · ` +
      `${s.missing} missing · ${s.duplicates} duplicated · ${s.unexpectedFiles} unexpected file(s) · ` +
      `${s.filesChecked} PDFs in ${((Date.now() - started) / 1000).toFixed(1)} s`,
  );
}
process.exit(report.summary.pass === report.summary.locations && report.summary.unexpectedFiles === 0 ? 0 : 1);
