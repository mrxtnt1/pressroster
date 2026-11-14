/**
 * Rules tests on synthetic inspections: no PDFs involved, so every boundary
 * (tolerance, orientation, QR ambiguity, roll-up) is pinned down exactly.
 */
import { describe, expect, it } from "vitest";
import { buildUrlOwners, evaluateMatchedFile, rollUp } from "@/lib/check/evaluate";
import { DEFAULT_SETTINGS, parseOrderCsv, type Finding, type PdfInspection } from "@/lib/check";

const URL = "https://order.example.com/s";
const parsed = parseOrderCsv(
  [
    "location_id,expected_qr_url,width,height,unit",
    `STORE-1,${URL}/1?x=1#top,24,36,in`,
    `STORE-2,${URL}/2,210,297,mm`,
  ].join("\n"),
);
if (!parsed.ok) throw new Error("fixture CSV invalid");
const [row1, row2] = parsed.rows;
const context = { settings: DEFAULT_SETTINGS, urlOwners: buildUrlOwners(parsed.rows) };

function inspection(overrides: Partial<PdfInspection> = {}): PdfInspection {
  return {
    byteLength: 1000,
    pageCount: 1,
    pdfVersion: "1.7",
    problems: [],
    geometry: {
      ok: true,
      source: "TrimBox",
      widthMm: 609.6,
      heightMm: 914.4,
      rotation: 0,
      userUnit: 1,
      boxes: { mediaBox: { x0: 0, y0: 0, x1: 1, y1: 1 }, cropBox: null, trimBox: null },
    },
    qr: { status: "decoded", symbols: [{ text: `${URL}/1?x=1#top`, corners: [] }], unreadable: 0, dpi: 200 },
    ...overrides,
  };
}

function size(widthMm: number, heightMm: number, rotation: 0 | 90 | 180 | 270 = 0): Partial<PdfInspection> {
  const base = inspection().geometry;
  if (!base.ok) throw new Error();
  return { geometry: { ...base, widthMm, heightMm, rotation } };
}

function qr(...texts: string[]): Partial<PdfInspection> {
  return { qr: { status: "decoded", symbols: texts.map((text) => ({ text, corners: [] })), unreadable: 0, dpi: 200 } };
}

function evaluate(overrides: Partial<PdfInspection>, opts: { row?: typeof row1; siblings?: string[]; orientation?: "either" | "strict" } = {}) {
  const findings = evaluateMatchedFile({
    filename: "STORE-1.pdf",
    row: opts.row ?? row1,
    siblings: opts.siblings ?? ["STORE-1.pdf"],
    inspection: inspection(overrides),
    context: { ...context, settings: { ...DEFAULT_SETTINGS, orientation: opts.orientation ?? "either" } },
  });
  const by = (check: Finding["check"]) => findings.find((f) => f.check === check)!;
  return { findings, file: by("file"), pdf: by("pdf"), dimensions: by("dimensions"), qr: by("qr"), status: rollUp(findings) };
}

describe("every file gets one finding per check", () => {
  it("passes a clean file and fills every field", () => {
    const r = evaluate({});
    expect(r.findings.map((f) => [f.check, f.status])).toEqual([
      ["file", "pass"],
      ["pdf", "pass"],
      ["dimensions", "pass"],
      ["qr", "pass"],
    ]);
    for (const f of r.findings) {
      expect(f).toMatchObject({ locationId: "STORE-1", filename: "STORE-1.pdf" });
      expect(f.expected).toBeTruthy();
      expect(f.actual).toBeTruthy();
      expect(f.reason).toBeTruthy();
    }
    expect(r.dimensions.expected).toBe("24 × 36 in (609.6 × 914.4 mm)");
    expect(r.dimensions.actual).toBe("24 × 36 in (609.6 × 914.4 mm) · TrimBox");
    expect(r.status).toBe("pass");
  });
});

describe("finished dimensions (±1 mm pilot default)", () => {
  it("passes at exactly +1 mm and fails just beyond it", () => {
    expect(evaluate(size(610.6, 913.4)).dimensions.status).toBe("pass");
    const off = evaluate(size(610.7, 914.4)).dimensions;
    expect(off.status).toBe("mismatch");
    expect(off.reason).toMatch(/off by \+1\.1 mm in width and ±0 mm in height/);
  });

  it("accepts swapped orientation by default, with a note, and rejects it in strict mode", () => {
    const swapped = evaluate(size(914.4, 609.6)).dimensions;
    expect(swapped.status).toBe("pass");
    expect(swapped.reason).toMatch(/the page is landscape, the order lists portrait/);
    const strict = evaluate(size(914.4, 609.6), { orientation: "strict" }).dimensions;
    expect(strict.status).toBe("mismatch");
    expect(strict.reason).toMatch(/Wrong orientation/);
  });

  it("reports the size source and rotation", () => {
    const r = evaluate(size(609.6, 914.4, 90)).dimensions;
    expect(r.actual).toBe("24 × 36 in (609.6 × 914.4 mm) · TrimBox · rotated 90°");
    expect(r.reason).toMatch(/Measured from the TrimBox, page rotated 90°/);
  });

  it("formats metric orders in mm only", () => {
    const r = evaluate({ ...size(210, 297), ...qr(`${URL}/2`) }, { row: row2 }).dimensions;
    expect(r).toMatchObject({ status: "pass", expected: "210 × 297 mm" });
  });

  it("never passes an unmeasured size", () => {
    const r = evaluate({ geometry: { ok: false, reason: "Not checked: the PDF has 2 pages." } });
    expect(r.dimensions).toMatchObject({ status: "needs_review", actual: null, reason: "Not checked: the PDF has 2 pages." });
    expect(r.status).toBe("needs_review");
  });
});

describe("QR destination", () => {
  it("compares the trimmed decoded text exactly, preserving query and fragment", () => {
    expect(evaluate(qr(`  ${URL}/1?x=1#top \n`)).qr.status).toBe("pass");
    expect(evaluate(qr(`${URL}/1?x=1`)).qr.reason).toMatch(/differ only in the query string or fragment/);
    expect(evaluate(qr(`${URL}/1?X=1#top`)).qr.status).toBe("mismatch");
    expect(evaluate(qr(`${URL.toUpperCase()}/1?X=1#TOP`)).qr.reason).toMatch(/only in letter case/);
  });

  it("names the location whose URL a wrong QR points to", () => {
    const r = evaluate(qr(`${URL}/2`)).qr;
    expect(r).toMatchObject({ status: "mismatch", actual: `${URL}/2` });
    expect(r.reason).toMatch(/It points to the URL for STORE-2\./);
  });

  it("treats identical copies as one code, different codes as ambiguous", () => {
    expect(evaluate(qr(`${URL}/1?x=1#top`, `${URL}/1?x=1#top`)).qr.status).toBe("pass");
    const ambiguous = evaluate(qr(`${URL}/1?x=1#top`, "https://app.example.com")).qr;
    expect(ambiguous.status).toBe("needs_review");
    expect(ambiguous.reason).toMatch(/Ambiguous/);
  });

  it("is a mismatch when none of several codes is the expected one", () => {
    expect(evaluate(qr(`${URL}/2`, "https://app.example.com")).qr.status).toBe("mismatch");
  });

  it("needs review when a matching code sits next to an unreadable one", () => {
    const r = evaluate({ qr: { status: "decoded", symbols: [{ text: `${URL}/1?x=1#top`, corners: [] }], unreadable: 1, dpi: 200 } });
    expect(r.qr.status).toBe("needs_review");
  });

  it("surfaces unreadable and unchecked QR codes as needs review", () => {
    expect(evaluate({ qr: { status: "unreadable", unreadable: 1, dpis: [200, 300, 100] } }).qr).toMatchObject({
      status: "needs_review",
      actual: "QR code found but unreadable",
    });
    expect(evaluate({ qr: { status: "unreadable", unreadable: 0, dpis: [200] } }).qr.reason).toMatch(/rendered at 200 DPI/);
    expect(evaluate({ qr: { status: "not_checked", reason: "Not checked: x." } }).qr.status).toBe("needs_review");
  });
});

describe("roll-up keeps proven discrepancies visible", () => {
  it("is a mismatch when one check fails even if another needs review", () => {
    const r = evaluate({ ...size(210, 297), qr: { status: "unreadable", unreadable: 0, dpis: [200] } });
    expect(r.dimensions.status).toBe("mismatch");
    expect(r.qr.status).toBe("needs_review");
    expect(r.status).toBe("mismatch");
  });

  it("marks duplicates as a mismatch while still checking the file's contents", () => {
    const r = evaluate({}, { siblings: ["STORE-1.pdf", "store-1.pdf"] });
    expect(r.file).toMatchObject({ status: "mismatch", actual: "2 files: STORE-1.pdf, store-1.pdf" });
    expect(r.qr.status).toBe("pass");
    expect(r.status).toBe("mismatch");
  });

  it("flags PDF problems as needs review without hiding the other results", () => {
    const r = evaluate({ problems: [{ code: "encrypted", message: "The PDF is encrypted." }] });
    expect(r.pdf).toMatchObject({ status: "needs_review", actual: "Encrypted" });
    expect(r.dimensions.status).toBe("pass");
    expect(r.status).toBe("needs_review");
  });
});
