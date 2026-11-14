import { parseOrderCsv } from "./csv";
import { describeError } from "./geometry";
import { buildUrlOwners, evaluateMatchedFile, missingFileFinding, rollUp, unexpectedFileFinding } from "./evaluate";
import { inspectPdf } from "./inspect";
import { matchFiles, parseFileName, suggestLocations } from "./match";
import {
  DEFAULT_SETTINGS,
  type BatchFile,
  type BatchResult,
  type CheckRuntime,
  type CheckSettings,
  type FileResult,
  type LocationResult,
  type PdfInspection,
} from "./types";

export interface BatchProgress {
  done: number;
  total: number;
  /** File being checked next, or `null` when finished. */
  filename: string | null;
}

export interface CheckBatchOptions {
  settings?: Partial<CheckSettings>;
  onProgress?: (progress: BatchProgress) => void;
  signal?: AbortSignal;
}

/**
 * Check a batch of production PDFs against a client order CSV.
 *
 * Files are processed one at a time to keep memory flat on large batches.
 * A CSV with any error stops the run: checking a partial order could let a
 * location that was dropped from the CSV look like it passed.
 */
export async function checkBatch(
  input: { csv: string | Uint8Array; files: BatchFile[] },
  runtime: CheckRuntime,
  options: CheckBatchOptions = {},
): Promise<BatchResult> {
  const settings: CheckSettings = { ...DEFAULT_SETTINGS, ...options.settings };
  const parsed = parseOrderCsv(input.csv);
  if (!parsed.ok) return { ok: false, csvErrors: parsed.errors };

  const rows = parsed.rows;
  const { byLocation, unexpected } = matchFiles(rows, input.files);
  const context = { settings, urlOwners: buildUrlOwners(rows) };

  const total = input.files.length - unexpected.length;
  let done = 0;
  const progress = (filename: string | null) => options.onProgress?.({ done, total, filename });

  const locations: LocationResult[] = [];
  for (const row of rows) {
    const files = byLocation.get(row.matchKey) ?? [];
    if (files.length === 0) {
      const finding = missingFileFinding(row);
      locations.push({
        locationId: row.locationId,
        row: row.row,
        expected: row,
        status: "mismatch",
        files: [],
        findings: [finding],
      });
      continue;
    }

    const siblings = files.map((f) => f.name);
    const fileResults: FileResult[] = [];
    for (const file of files) {
      options.signal?.throwIfAborted();
      progress(file.name);
      const inspection = await inspectFile(file, runtime, settings);
      const findings = evaluateMatchedFile({ filename: file.name, row, siblings, inspection, context });
      fileResults.push({
        filename: file.name,
        locationId: row.locationId,
        status: rollUp(findings),
        findings,
        inspection,
      });
      done += 1;
    }
    const findings = fileResults.flatMap((f) => f.findings);
    locations.push({
      locationId: row.locationId,
      row: row.row,
      expected: row,
      status: rollUp(findings),
      files: fileResults,
      findings,
    });
  }
  progress(null);

  const missing = new Set(rows.filter((r) => (byLocation.get(r.matchKey) ?? []).length === 0).map((r) => r.matchKey));
  const unexpectedFiles: FileResult[] = unexpected.map((file) => {
    const finding = unexpectedFileFinding(file.name, suggestLocations(file.name, rows, missing));
    return { filename: file.name, locationId: null, status: "mismatch", findings: [finding], inspection: null };
  });

  const count = (status: string) => locations.filter((l) => l.status === status).length;
  return {
    ok: true,
    report: {
      generatedAt: new Date().toISOString(),
      settings,
      summary: {
        locations: locations.length,
        pass: count("pass"),
        mismatch: count("mismatch"),
        needsReview: count("needs_review"),
        missing: locations.filter((l) => l.files.length === 0).length,
        duplicates: locations.filter((l) => l.files.length > 1).length,
        unexpectedFiles: unexpectedFiles.length,
        filesChecked: done,
      },
      locations,
      unexpectedFiles,
      findings: [...locations.flatMap((l) => l.findings), ...unexpectedFiles.flatMap((f) => f.findings)],
    },
  };
}

async function inspectFile(file: BatchFile, runtime: CheckRuntime, settings: CheckSettings): Promise<PdfInspection> {
  const name = parseFileName(file.name);
  let bytes: Uint8Array;
  try {
    bytes = await file.read();
  } catch (error) {
    const reason = `Not checked: the file could not be read (${describeError(error)}).`;
    return {
      byteLength: file.size,
      pageCount: null,
      pdfVersion: null,
      problems: [{ code: "corrupt", message: `The file could not be read (${describeError(error)}).` }],
      geometry: { ok: false, reason },
      qr: { status: "not_checked", reason },
    };
  }
  return inspectPdf(bytes, { isPdfName: name.isPdfName, extension: name.extension }, runtime, settings);
}
