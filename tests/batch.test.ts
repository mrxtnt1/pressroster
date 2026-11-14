/** End-to-end batch checks on the committed fixture batches. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { checkBatch, type BatchReport, type FindingStatus } from "@/lib/check";
import { fixtureBytes, loadBatch, memoryFile, runtime } from "./helpers";

async function run(name: string) {
  const batch = await loadBatch(name);
  const result = await checkBatch(batch, runtime);
  if (!result.ok) throw new Error(JSON.stringify(result.csvErrors));
  return result.report;
}

const statuses = (report: BatchReport) =>
  Object.fromEntries(report.locations.map((l) => [l.locationId, l.status])) as Record<string, FindingStatus>;

function finding(report: BatchReport, locationId: string, check: string, filename?: string) {
  const f = report.findings.find(
    (x) => x.locationId === locationId && x.check === check && (filename === undefined || x.filename === filename),
  );
  if (!f) throw new Error(`no ${check} finding for ${locationId}`);
  return f;
}

describe("passing batch", () => {
  let report: BatchReport;
  beforeAll(async () => {
    report = await run("passing");
  });

  it("passes every location", () => {
    expect(statuses(report)).toEqual({ "STORE-001": "pass", "STORE-002": "pass", "0042": "pass" });
    expect(report.summary).toMatchObject({ locations: 3, pass: 3, mismatch: 0, needsReview: 0, filesChecked: 3 });
  });

  it("reports the size source for each file", () => {
    expect(finding(report, "0042", "dimensions").actual).toBe(
      "24 × 36 in (609.6 × 914.4 mm) · TrimBox · rotated 90°".replace("24 × 36 in", "60.96 × 91.44 cm"),
    );
    expect(finding(report, "STORE-001", "dimensions").actual).toMatch(/· MediaBox$/);
  });

  it("records the settings used, including the ±1 mm pilot tolerance", () => {
    expect(report.settings.toleranceMm).toBe(1);
  });
});

describe("mixed batch: every failure mode", () => {
  let report: BatchReport;
  beforeAll(async () => {
    report = await run("mixed");
  });

  it("assigns the expected status to every location", () => {
    expect(statuses(report)).toEqual({
      "STORE-101": "pass", // matched case-insensitively
      "STORE-102": "mismatch", // valid QR, wrong store
      "STORE-103": "mismatch", // wrong finished size
      "STORE-104": "mismatch", // missing
      "STORE-105": "mismatch", // duplicate
      "STORE-106": "needs_review", // unreadable QR
      "STORE-107": "needs_review", // truncated PDF
      "STORE-108": "needs_review", // password-protected
      "STORE-109": "needs_review", // two pages
      "STORE-110": "needs_review", // two different QR codes
      "STORE-111": "mismatch", // wrong size + no QR: the proven problem wins
      "STORE-112": "pass", // landscape delivery within tolerance
    });
    expect(report.summary).toMatchObject({
      locations: 12,
      pass: 2,
      mismatch: 5,
      needsReview: 5,
      missing: 1,
      duplicates: 1,
      unexpectedFiles: 1,
      filesChecked: 12,
    });
  });

  it("explains a QR that scans but points to the wrong location", () => {
    expect(finding(report, "STORE-102", "qr")).toMatchObject({
      filename: "STORE-102.pdf",
      status: "mismatch",
      expected: "https://order.example.com/s/STORE-102",
      actual: "https://order.example.com/s/STORE-103",
    });
    expect(finding(report, "STORE-102", "qr").reason).toMatch(/points to the URL for STORE-103/);
    expect(finding(report, "STORE-102", "dimensions").status).toBe("pass");
  });

  it("reports wrong finished dimensions from the TrimBox", () => {
    expect(finding(report, "STORE-103", "dimensions")).toMatchObject({
      status: "mismatch",
      expected: "24 × 36 in (609.6 × 914.4 mm)",
      actual: "18 × 24 in (457.2 × 609.6 mm) · TrimBox",
    });
    expect(finding(report, "STORE-103", "qr").status).toBe("pass");
  });

  it("reports missing artwork and the unexpected file that was probably meant for it", () => {
    expect(finding(report, "STORE-104", "file")).toMatchObject({ filename: null, status: "mismatch", actual: "No matching file" });
    expect(report.unexpectedFiles).toHaveLength(1);
    expect(report.unexpectedFiles[0].findings[0]).toMatchObject({ locationId: null, filename: "STORE-14.pdf", status: "mismatch" });
    expect(report.unexpectedFiles[0].findings[0].reason).toMatch(/Did you mean STORE-104\.pdf\?/);
  });

  it("reports both duplicate files and still checks each one", () => {
    const location = report.locations.find((l) => l.locationId === "STORE-105")!;
    expect(location.files.map((f) => f.filename).sort()).toEqual(["STORE-105 .pdf", "STORE-105.pdf"]);
    for (const file of location.files) {
      expect(file.findings.map((f) => [f.check, f.status])).toEqual([
        ["file", "mismatch"],
        ["pdf", "pass"],
        ["dimensions", "pass"],
        ["qr", "pass"],
      ]);
    }
  });

  it("keeps the proven size problem visible next to the QR that needs review", () => {
    expect(finding(report, "STORE-111", "dimensions").status).toBe("mismatch");
    expect(finding(report, "STORE-111", "qr")).toMatchObject({ status: "needs_review", actual: "No readable QR code" });
  });

  it("notes a landscape delivery of a portrait order", () => {
    expect(finding(report, "STORE-112", "dimensions").reason).toMatch(/swapped: the page is landscape, the order lists portrait/);
  });

  it("never passes a location with an incomplete check", () => {
    for (const location of report.locations) {
      if (location.status !== "pass") continue;
      expect(location.files).toHaveLength(1);
      expect(location.findings.map((f) => f.check)).toEqual(["file", "pdf", "dimensions", "qr"]);
      expect(location.findings.every((f) => f.status === "pass")).toBe(true);
    }
    for (const f of report.findings) {
      if (f.status === "pass") expect(f.actual).not.toBeNull();
      if (/^Not checked/.test(f.reason)) expect(f.status).not.toBe("pass");
    }
  });

  it("gives every finding the structured fields", () => {
    for (const f of report.findings) {
      expect(Object.keys(f).sort()).toEqual(["actual", "check", "expected", "filename", "locationId", "reason", "status"]);
      expect(f.reason.length).toBeGreaterThan(10);
    }
  });
});

describe("batch control flow", () => {
  it("stops before reading any PDF when the CSV is invalid", async () => {
    const read = vi.fn(async () => new Uint8Array());
    const result = await checkBatch(
      { csv: await fixtureBytes("csv/duplicate-ids.csv"), files: [{ name: "STORE-001.pdf", size: 0, read }] },
      runtime,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.csvErrors.length).toBe(2);
    expect(read).not.toHaveBeenCalled();
  });

  it("reports progress and honours cancellation", async () => {
    const batch = await loadBatch("passing");
    const onProgress = vi.fn();
    await checkBatch(batch, runtime, { onProgress });
    // Files are checked in CSV order.
    expect(onProgress.mock.calls.map(([p]) => p.filename)).toEqual(["STORE-001.pdf", "STORE-002.pdf", "0042.pdf", null]);
    expect(onProgress).toHaveBeenCalledWith({ done: 0, total: 3, filename: "STORE-001.pdf" });
    expect(onProgress).toHaveBeenLastCalledWith({ done: 3, total: 3, filename: null });

    const controller = new AbortController();
    controller.abort();
    await expect(checkBatch(batch, runtime, { signal: controller.signal })).rejects.toThrow();
  });

  it("turns a file that can't be read into a needs-review result", async () => {
    const batch = await loadBatch("passing");
    const files = batch.files.map((f) =>
      f.name === "0042.pdf" ? { ...f, read: async () => Promise.reject(new Error("permission denied")) } : f,
    );
    const result = await checkBatch({ ...batch, files }, runtime);
    expect(result.ok && result.report.locations.find((l) => l.locationId === "0042")!.status).toBe("needs_review");
  });

  it("matches files whose names differ only by case or outer whitespace", async () => {
    const bytes = await fixtureBytes("batches/passing/STORE-001.pdf");
    const csv = "location_id,expected_qr_url,width,height,unit\nstore-001,https://order.example.com/s/STORE-001?utm_source=window&loc=001#menu,11,17,in\n";
    const result = await checkBatch({ csv, files: [memoryFile("  STORE-001  .PDF", bytes)] }, runtime);
    expect(result.ok && result.report.locations[0].status).toBe("pass");
  });
});
