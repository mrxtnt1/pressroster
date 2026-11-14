import { formatSizeWithMm, formatSignedMm, toMm } from "./units";
import type {
  CheckSettings,
  Finding,
  FindingStatus,
  OrderRow,
  PdfInspection,
  PdfProblemCode,
} from "./types";

export interface EvaluationContext {
  settings: CheckSettings;
  /** Trimmed expected URL → location IDs that expect it (for wrong-store hints). */
  urlOwners: Map<string, string[]>;
}

export function buildUrlOwners(rows: OrderRow[]): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const row of rows) {
    const list = owners.get(row.expectedQrUrl) ?? [];
    list.push(row.locationId);
    owners.set(row.expectedQrUrl, list);
  }
  return owners;
}

/** Worst status wins: Mismatch > Needs review > Pass. */
export function rollUp(findings: Finding[]): FindingStatus {
  if (findings.some((f) => f.status === "mismatch")) return "mismatch";
  if (findings.some((f) => f.status === "needs_review")) return "needs_review";
  return "pass";
}

export function missingFileFinding(row: OrderRow): Finding {
  return {
    locationId: row.locationId,
    filename: null,
    check: "file",
    status: "mismatch",
    expected: `${row.locationId}.pdf`,
    actual: "No matching file",
    reason: `Missing artwork: no file in the batch is named ${row.locationId}.pdf.`,
  };
}

export function unexpectedFileFinding(filename: string, suggestions: string[]): Finding {
  const hint =
    suggestions.length > 0 ? ` Did you mean ${suggestions.map((s) => `${s}.pdf`).join(" or ")}?` : "";
  return {
    locationId: null,
    filename,
    check: "file",
    status: "mismatch",
    expected: "A filename that matches a location_id in the order",
    actual: filename,
    reason: `Unexpected file: no location in the order matches this filename.${hint}`,
  };
}

/** All findings for one file that matched a CSV row. */
export function evaluateMatchedFile(args: {
  filename: string;
  row: OrderRow;
  /** Every filename that matched this row (length > 1 means duplicates). */
  siblings: string[];
  inspection: PdfInspection;
  context: EvaluationContext;
}): Finding[] {
  const { filename, row, siblings, inspection, context } = args;
  const base = { locationId: row.locationId, filename };
  return [
    { ...base, ...fileFinding(row, filename, siblings) },
    { ...base, ...pdfFinding(inspection) },
    { ...base, ...dimensionsFinding(row, inspection, context.settings) },
    { ...base, ...qrFinding(row, inspection, context.urlOwners) },
  ];
}

type FindingBody = Omit<Finding, "locationId" | "filename">;

function fileFinding(row: OrderRow, filename: string, siblings: string[]): FindingBody {
  if (siblings.length > 1) {
    return {
      check: "file",
      status: "mismatch",
      expected: `One file for ${row.locationId}`,
      actual: `${siblings.length} files: ${siblings.join(", ")}`,
      reason: `Duplicate artwork: ${siblings.length} files match ${row.locationId}. Keep one and remove the others.`,
    };
  }
  return {
    check: "file",
    status: "pass",
    expected: `${row.locationId}.pdf`,
    actual: filename,
    reason: `Filename matches location ${row.locationId}.`,
  };
}

const PROBLEM_LABEL: Record<PdfProblemCode, string> = {
  not_pdf: "Not a PDF",
  truncated: "Truncated",
  corrupt: "Damaged",
  password_protected: "Password-protected",
  encrypted: "Encrypted",
  multi_page: "Multiple pages",
  no_pages: "No pages",
  wrong_extension: "Not a .pdf file",
  render_failed: "Render failed",
};

function pdfFinding(inspection: PdfInspection): FindingBody {
  const expected = "Readable single-page PDF";
  if (inspection.problems.length === 0) {
    const version = inspection.pdfVersion ? `PDF ${inspection.pdfVersion}` : "PDF";
    return {
      check: "pdf",
      status: "pass",
      expected,
      actual: `${version}, 1 page`,
      reason: "The PDF opens and has one page.",
    };
  }
  const labels = [...new Set(inspection.problems.map((p) => PROBLEM_LABEL[p.code]))];
  const pages =
    inspection.pageCount !== null && inspection.problems.some((p) => p.code === "multi_page")
      ? ` (${inspection.pageCount} pages)`
      : "";
  return {
    check: "pdf",
    status: "needs_review",
    expected,
    actual: labels.join(", ") + pages,
    reason: [...new Set(inspection.problems.map((p) => p.message))].join(" "),
  };
}

const EPSILON_MM = 1e-6;

function dimensionsFinding(row: OrderRow, inspection: PdfInspection, settings: CheckSettings): FindingBody {
  const expectedW = toMm(row.width, row.unit);
  const expectedH = toMm(row.height, row.unit);
  const expected = formatSizeWithMm(expectedW, expectedH, row.unit);
  const geometry = inspection.geometry;
  if (!geometry.ok) {
    return { check: "dimensions", status: "needs_review", expected, actual: null, reason: geometry.reason };
  }

  const { widthMm, heightMm, source, rotation } = geometry;
  const tol = settings.toleranceMm + EPSILON_MM;
  const asOrdered = { dw: widthMm - expectedW, dh: heightMm - expectedH };
  const swapped = { dw: heightMm - expectedW, dh: widthMm - expectedH };
  const fits = (d: { dw: number; dh: number }) => Math.abs(d.dw) <= tol && Math.abs(d.dh) <= tol;

  const notes = [`Measured from the ${source}`];
  if (rotation !== 0) notes.push(`page rotated ${rotation}°`);
  const actual = `${formatSizeWithMm(widthMm, heightMm, row.unit)} · ${source}${rotation ? ` · rotated ${rotation}°` : ""}`;
  const tolerance = `±${settings.toleranceMm} mm`;

  if (fits(asOrdered)) {
    return {
      check: "dimensions",
      status: "pass",
      expected,
      actual,
      reason: `Finished size matches within ${tolerance}. ${notes.join(", ")}.`,
    };
  }
  if (fits(swapped)) {
    const pageIs = widthMm > heightMm ? "landscape" : "portrait";
    const orderIs = expectedW > expectedH ? "landscape" : "portrait";
    const swapNote = `the page is ${pageIs}, the order lists ${orderIs}`;
    return settings.orientation === "either"
      ? {
          check: "dimensions",
          status: "pass",
          expected,
          actual,
          reason: `Finished size matches within ${tolerance} with width and height swapped: ${swapNote}. ${notes.join(", ")}.`,
        }
      : {
          check: "dimensions",
          status: "mismatch",
          expected,
          actual,
          reason: `Wrong orientation: width and height are swapped (${swapNote}). ${notes.join(", ")}.`,
        };
  }

  const closest =
    settings.orientation === "either" &&
    Math.abs(swapped.dw) + Math.abs(swapped.dh) < Math.abs(asOrdered.dw) + Math.abs(asOrdered.dh)
      ? swapped
      : asOrdered;
  return {
    check: "dimensions",
    status: "mismatch",
    expected,
    actual,
    reason:
      `Wrong finished size: off by ${formatSignedMm(closest.dw)} in width and ${formatSignedMm(closest.dh)} ` +
      `in height (tolerance ${tolerance}). ${notes.join(", ")}.`,
  };
}

function qrFinding(row: OrderRow, inspection: PdfInspection, urlOwners: Map<string, string[]>): FindingBody {
  const expected = row.expectedQrUrl;
  const qr = inspection.qr;

  if (qr.status === "not_checked") {
    return { check: "qr", status: "needs_review", expected, actual: null, reason: qr.reason };
  }
  if (qr.status === "unreadable") {
    const dpis = listDpis(qr.dpis);
    return {
      check: "qr",
      status: "needs_review",
      expected,
      actual: qr.unreadable > 0 ? "QR code found but unreadable" : "No readable QR code",
      reason:
        qr.unreadable > 0
          ? `A QR code was found but could not be decoded (rendered at ${dpis}). It may be damaged, ` +
            "covered by artwork, or below error-correction limits. Check it by hand before printing."
          : `No readable QR code was found (rendered at ${dpis}). The code may be missing, too small, ` +
            "low-contrast or covered by artwork.",
    };
  }

  const texts = [...new Set(qr.symbols.map((s) => s.text.trim()))];
  const actual = texts.join(" | ");

  if (!texts.includes(expected)) {
    const reasons: string[] = [];
    if (texts.length === 1) {
      reasons.push("Wrong QR destination: the QR code decodes, but not to this location's URL.");
      const owners = (urlOwners.get(texts[0]) ?? []).filter((id) => id !== row.locationId);
      if (owners.length > 0) reasons.push(`It points to the URL for ${owners.join(", ")}.`);
      const near = nearMiss(expected, texts[0]);
      if (near) reasons.push(near);
    } else {
      reasons.push(`Wrong QR destination: none of the ${texts.length} QR codes on the page points to this location's URL.`);
    }
    return { check: "qr", status: "mismatch", expected, actual, reason: reasons.join(" ") };
  }

  if (texts.length > 1) {
    return {
      check: "qr",
      status: "needs_review",
      expected,
      actual,
      reason: `Ambiguous: the page has ${texts.length} QR codes with different URLs. One matches; confirm which one customers should scan.`,
    };
  }
  if (qr.unreadable > 0) {
    return {
      check: "qr",
      status: "needs_review",
      expected,
      actual,
      reason: "One QR code matches, but another QR-like mark on the page could not be read. Check it by hand.",
    };
  }
  const copies = qr.symbols.length > 1 ? ` (${qr.symbols.length} identical codes)` : "";
  return {
    check: "qr",
    status: "pass",
    expected,
    actual,
    reason: `QR code decodes to the expected URL${copies}. Compared as text; the URL was not opened.`,
  };
}

function listDpis(dpis: number[]): string {
  if (dpis.length <= 1) return `${dpis.join("")} DPI`;
  return `${dpis.slice(0, -1).join(", ")} and ${dpis[dpis.length - 1]} DPI`;
}

/** Explain differences people often miss. Advisory text only. */
function nearMiss(expected: string, actual: string): string | null {
  if (expected.toLowerCase() === actual.toLowerCase()) {
    return "The URLs differ only in letter case. Paths and query strings can be case-sensitive.";
  }
  const strip = (s: string) => s.replace(/\/$/, "");
  if (strip(expected) === strip(actual)) return "The URLs differ only by a trailing slash.";
  const noTail = (s: string) => s.split(/[?#]/)[0];
  if (noTail(expected) === noTail(actual)) {
    return "The URLs differ only in the query string or fragment (tracking parameters can matter).";
  }
  return null;
}
