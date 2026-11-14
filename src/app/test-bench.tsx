"use client";

import { useRef, useState } from "react";
import {
  checkBatch,
  formatCsvError,
  type BatchFile,
  type BatchProgress,
  type BatchResult,
  type CheckName,
  type Finding,
  type FindingStatus,
} from "@/lib/check";
import { createBrowserRuntime } from "@/lib/check/runtime-browser";

const STATUS_LABEL: Record<FindingStatus, string> = {
  pass: "Pass",
  mismatch: "Mismatch",
  needs_review: "Needs review",
};

const STATUS_CLASS: Record<FindingStatus, string> = {
  pass: "bg-pass-bg text-pass",
  mismatch: "bg-mismatch-bg text-mismatch",
  needs_review: "bg-review-bg text-review",
};

const CHECK_LABEL: Record<CheckName, string> = {
  file: "Artwork file",
  pdf: "PDF",
  dimensions: "Finished size",
  qr: "QR destination",
};

function toBatchFile(file: File): BatchFile {
  return { name: file.name, size: file.size, read: async () => new Uint8Array(await file.arrayBuffer()) };
}

export function TestBench() {
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [pdfFiles, setPdfFiles] = useState<File[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<BatchProgress | null>(null);
  const [result, setResult] = useState<BatchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runtime = useRef<ReturnType<typeof createBrowserRuntime> | null>(null);

  async function run(csv: File, pdfs: File[]) {
    setRunning(true);
    setResult(null);
    setError(null);
    setProgress(null);
    try {
      runtime.current ??= createBrowserRuntime();
      const outcome = await checkBatch(
        { csv: new Uint8Array(await csv.arrayBuffer()), files: pdfs.map(toBatchFile) },
        runtime.current,
        { onProgress: setProgress },
      );
      setResult(outcome);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  async function runSample(name: string) {
    setError(null);
    try {
      const manifest = await fetch("/samples/manifest.json").then((r) => r.json());
      const entry = manifest[name] as { csv: string; files: string[] };
      const load = async (file: string, type: string) => {
        const res = await fetch(`/samples/${name}/${encodeURIComponent(file)}`);
        if (!res.ok) throw new Error(`Could not load sample file ${file}`);
        return new File([await res.blob()], file, { type });
      };
      const csv = await load(entry.csv, "text/csv");
      const pdfs = await Promise.all(entry.files.map((f) => load(f, "application/pdf")));
      setCsvFile(csv);
      setPdfFiles(pdfs);
      await run(csv, pdfs);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function downloadJson() {
    if (!result?.ok) return;
    const blob = new Blob([JSON.stringify(result.report, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `pressroster-report-${result.report.generatedAt.slice(0, 19).replace(/[:T]/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-border bg-surface p-4 sm:p-6" aria-labelledby="inputs-heading">
        <h2 id="inputs-heading" className="sr-only">
          Inputs
        </h2>
        <div className="grid gap-5 md:grid-cols-2">
          <label className="block">
            <span className="text-sm font-medium">1. Order CSV</span>
            <span className="mt-0.5 block text-xs text-muted">
              Columns: location_id, expected_qr_url, width, height, unit (mm, cm or in)
            </span>
            <input
              data-testid="csv-input"
              type="file"
              accept=".csv,text/csv"
              disabled={running}
              onChange={(e) => setCsvFile(e.target.files?.[0] ?? null)}
              className="mt-2 block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-brand file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">2. Production PDFs</span>
            <span className="mt-0.5 block text-xs text-muted">One single-page PDF per location, named LOCATION-ID.pdf</span>
            <input
              data-testid="pdf-input"
              type="file"
              accept=".pdf,application/pdf"
              multiple
              disabled={running}
              onChange={(e) => setPdfFiles(Array.from(e.target.files ?? []))}
              className="mt-2 block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-brand file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white"
            />
          </label>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            data-testid="run"
            disabled={running || !csvFile}
            onClick={() => csvFile && run(csvFile, pdfFiles)}
            className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-40"
          >
            {running ? "Checking…" : "Check batch"}
          </button>
          <span className="text-sm text-muted">
            {csvFile ? csvFile.name : "No CSV"} · {pdfFiles.length} PDF{pdfFiles.length === 1 ? "" : "s"}
          </span>
          <span className="hidden h-5 w-px bg-border sm:block" aria-hidden />
          <span className="text-sm text-muted">Samples:</span>
          {["passing", "mixed"].map((name) => (
            <button
              key={name}
              type="button"
              data-testid={`sample-${name}`}
              disabled={running}
              onClick={() => runSample(name)}
              className="rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-40"
            >
              {name === "passing" ? "Passing batch" : "Every failure mode"}
            </button>
          ))}
        </div>
        <p className="mt-3 min-h-5 text-sm text-muted" aria-live="polite" data-testid="progress">
          {running && progress?.filename
            ? `Checking ${progress.done + 1} of ${progress.total}: ${progress.filename}`
            : running
              ? "Preparing…"
              : ""}
        </p>
      </section>

      {error && (
        <p role="alert" className="rounded-lg bg-mismatch-bg p-4 text-sm text-mismatch">
          {error}
        </p>
      )}

      {result && !result.ok && (
        <section role="alert" data-testid="csv-errors" className="rounded-xl border border-mismatch/40 bg-mismatch-bg p-4 sm:p-6">
          <h2 className="font-semibold text-mismatch">
            The order CSV has {result.csvErrors.length} problem{result.csvErrors.length === 1 ? "" : "s"}. Nothing was checked.
          </h2>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
            {result.csvErrors.map((e, i) => (
              <li key={i} data-testid="csv-error" data-row={e.row ?? ""}>
                {formatCsvError(e)}
              </li>
            ))}
          </ul>
        </section>
      )}

      {result?.ok && <Report report={result.report} onDownload={downloadJson} />}
    </div>
  );
}

function Badge({ status }: { status: FindingStatus }) {
  return (
    <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_CLASS[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

function Report({
  report,
  onDownload,
}: {
  report: Extract<BatchResult, { ok: true }>["report"];
  onDownload: () => void;
}) {
  const s = report.summary;
  const groups: { key: string; title: string; status: FindingStatus; findings: Finding[] }[] = [
    ...report.locations.map((l) => ({ key: `loc-${l.locationId}`, title: l.locationId, status: l.status, findings: l.findings })),
    ...report.unexpectedFiles.map((f) => ({ key: `file-${f.filename}`, title: "No matching location", status: f.status, findings: f.findings })),
  ];

  return (
    <section aria-labelledby="results-heading" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="results-heading" className="text-lg font-semibold">
            Results
          </h2>
          <p className="text-sm text-muted" data-testid="summary">
            {s.locations} locations · <span className="text-pass">{s.pass} pass</span> ·{" "}
            <span className="text-mismatch">{s.mismatch} mismatch</span> ·{" "}
            <span className="text-review">{s.needsReview} needs review</span> · {s.missing} missing · {s.duplicates}{" "}
            duplicated · {s.unexpectedFiles} unexpected file{s.unexpectedFiles === 1 ? "" : "s"}
          </p>
          <p className="text-xs text-muted">
            Tolerance ±{report.settings.toleranceMm} mm per edge · orientation: {report.settings.orientation} · QR rendered
            at up to {report.settings.qrDpis.join("/")} DPI
          </p>
        </div>
        <button type="button" onClick={onDownload} className="rounded-md border border-border px-3 py-1.5 text-sm">
          Download JSON
        </button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border bg-surface">
        <table className="w-full min-w-[56rem] border-collapse text-left text-sm">
          <thead className="border-b border-border text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Check</th>
              <th className="px-3 py-2 font-medium">File</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Expected</th>
              <th className="px-3 py-2 font-medium">Actual</th>
              <th className="px-3 py-2 font-medium">Reason</th>
            </tr>
          </thead>
          {groups.map((group) => (
            <tbody
              key={group.key}
              data-testid="location"
              data-location={group.title}
              data-status={group.status}
              className="border-b border-border last:border-b-0"
            >
              <tr className="bg-background/60">
                <th colSpan={6} scope="rowgroup" className="px-3 py-2">
                  <span className="mr-2 font-mono font-semibold">{group.title}</span>
                  <Badge status={group.status} />
                </th>
              </tr>
              {group.findings.map((f, i) => (
                <tr
                  key={i}
                  data-testid="finding"
                  data-check={f.check}
                  data-status={f.status}
                  data-filename={f.filename ?? ""}
                  className="align-top"
                >
                  <td className="px-3 py-2 whitespace-nowrap">{CHECK_LABEL[f.check]}</td>
                  <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">{f.filename ?? "—"}</td>
                  <td className="px-3 py-2">
                    <Badge status={f.status} />
                  </td>
                  <td className="px-3 py-2 text-xs [overflow-wrap:anywhere]" data-field="expected">
                    {f.expected ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-xs [overflow-wrap:anywhere]" data-field="actual">
                    {f.actual ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted" data-field="reason">
                    {f.reason}
                  </td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
    </section>
  );
}
