/**
 * The real render + QR decode path on committed binary PDF fixtures:
 * pdf.js (legacy build) → canvas → zxing-wasm, exactly as in the browser.
 */
import { PDFDocument } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, inspectPdf, type PdfInspection } from "@/lib/check";
import { fixtureBytes, runtime } from "./helpers";

const URL = "https://order.example.com/s";

async function inspect(rel: string | Uint8Array, name = { isPdfName: true, extension: "pdf" as string | null }) {
  const bytes = typeof rel === "string" ? await fixtureBytes(rel) : rel;
  return inspectPdf(bytes, name, runtime, DEFAULT_SETTINGS);
}

const texts = (i: PdfInspection) => (i.qr.status === "decoded" ? i.qr.symbols.map((s) => s.text) : []);
const codes = (i: PdfInspection) => i.problems.map((p) => p.code);

describe("readable artwork", () => {
  it("decodes a vector QR with query string and fragment intact (pdf-lib, classic xref)", async () => {
    const i = await inspect("batches/passing/STORE-001.pdf");
    expect(codes(i)).toEqual([]);
    expect(i).toMatchObject({ pageCount: 1, pdfVersion: "1.7" });
    expect(texts(i)).toEqual([`${URL}/STORE-001?utm_source=window&loc=001#menu`]);
    expect(i.qr).toMatchObject({ status: "decoded", unreadable: 0, dpi: 200 });
  });

  it("reads a Chromium/Skia export with an SVG QR", async () => {
    const i = await inspect("batches/passing/STORE-002.pdf");
    expect(codes(i)).toEqual([]);
    expect(texts(i)).toEqual([`${URL}/STORE-002`]);
    expect(i.geometry).toMatchObject({ ok: true, source: "MediaBox", rotation: 0 });
    if (i.geometry.ok) {
      expect(Math.abs(i.geometry.widthMm - 210)).toBeLessThan(1);
      expect(Math.abs(i.geometry.heightMm - 297)).toBeLessThan(1);
    }
  });

  it("measures trim + rotation and decodes a raster QR (0042)", async () => {
    const i = await inspect("batches/passing/0042.pdf");
    expect(i.geometry).toMatchObject({ ok: true, source: "TrimBox", rotation: 90 });
    if (i.geometry.ok) {
      // Stored as a 36.25 × 24.25 in landscape MediaBox; finishes 24 × 36 in portrait.
      expect(i.geometry.widthMm).toBeCloseTo(609.6, 6);
      expect(i.geometry.heightMm).toBeCloseTo(914.4, 6);
      expect(i.geometry.boxes.mediaBox).toEqual({ x0: 0, y0: 0, x1: 36.25 * 72, y1: 24.25 * 72 });
    }
    expect(texts(i)).toEqual([`${URL}/0042`]);
  });

  it("finds both codes on a page with two different QR codes", async () => {
    const i = await inspect("batches/mixed/STORE-110.pdf");
    expect(texts(i).sort()).toEqual(["https://app.example.com/download?ref=poster", `${URL}/STORE-110`]);
  });

  it("decodes a valid QR that points to another store", async () => {
    expect(texts(await inspect("batches/mixed/STORE-102.pdf"))).toEqual([`${URL}/STORE-103`]);
  });
});

describe("artwork that can't be fully checked", () => {
  it("reports a damaged QR as found-but-unreadable after every render pass", async () => {
    const i = await inspect("batches/mixed/STORE-106.pdf");
    expect(i.qr.status).toBe("unreadable");
    if (i.qr.status === "unreadable") {
      expect(i.qr.unreadable).toBeGreaterThan(0);
      expect(i.qr.dpis).toHaveLength(3);
    }
    expect(i.geometry.ok).toBe(true); // the size is still measured
  });

  it("reports no QR at all on artwork without one", async () => {
    const i = await inspect("batches/mixed/STORE-111.pdf");
    expect(i.qr).toMatchObject({ status: "unreadable", unreadable: 0 });
  });

  it("flags a truncated PDF", async () => {
    const i = await inspect("batches/mixed/STORE-107.pdf");
    expect(codes(i)).toContain("truncated");
    expect(i.qr.status).not.toBe("decoded");
  });

  it("flags a password-protected PDF: the size is read from unencrypted page boxes, the QR can't be decoded", async () => {
    const i = await inspect("batches/mixed/STORE-108.pdf");
    expect(codes(i)).toEqual(["password_protected"]);
    expect(i.geometry).toMatchObject({ ok: true, source: "MediaBox" });
    expect(i.qr).toEqual({ status: "not_checked", reason: "Not checked: the PDF is password-protected." });
  });

  it("flags an encrypted PDF that opens without a password, but still measures it", async () => {
    const doc = await PDFDocument.load(await fixtureBytes("batches/passing/STORE-001.pdf"));
    doc.encrypt({ ownerPassword: "owner-only", permissions: { printing: "highResolution" } });
    const i = await inspect(await doc.save());
    expect(codes(i)).toEqual(["encrypted"]);
    expect(i.geometry.ok).toBe(true);
    expect(texts(i)).toEqual([`${URL}/STORE-001?utm_source=window&loc=001#menu`]);
  });

  it("does not measure or decode a multi-page PDF", async () => {
    const i = await inspect("batches/mixed/STORE-109.pdf");
    expect(codes(i)).toEqual(["multi_page"]);
    expect(i.pageCount).toBe(2);
    expect(i.geometry).toEqual({ ok: false, reason: "Not checked: the PDF has 2 pages." });
    expect(i.qr).toEqual({ status: "not_checked", reason: "Not checked: the PDF has 2 pages." });
  });

  it.each([
    ["empty file", new Uint8Array(), /empty \(0 bytes\)/],
    ["PNG renamed to .pdf", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]), /PNG image/],
    ["HTML error page", new TextEncoder().encode("<!doctype html><title>404</title>"), /HTML or XML/],
    ["random bytes", new Uint8Array(4096).map((_, i) => (i * 7919) % 251), /does not start with a PDF header/],
  ])("rejects a non-PDF: %s", async (_, bytes, message) => {
    const i = await inspect(bytes as Uint8Array);
    expect(codes(i)).toEqual(["not_pdf"]);
    expect(i.problems[0].message).toMatch(message);
    expect(i.geometry.ok).toBe(false);
    expect(i.qr.status).toBe("not_checked");
  });

  it("flags a PDF-compatible file without a .pdf name but still checks it", async () => {
    const i = await inspect("batches/passing/STORE-001.pdf", { isPdfName: false, extension: "ai" });
    expect(codes(i)).toEqual(["wrong_extension"]);
    expect(texts(i)).toHaveLength(1);
  });

  it("damaged bytes inside an otherwise intact file never yield a passing QR result silently", async () => {
    const bytes = await fixtureBytes("batches/passing/STORE-001.pdf");
    const broken = bytes.slice();
    const start = new TextDecoder("latin1").decode(broken).indexOf("stream");
    for (let k = start + 10; k < start + 400; k++) broken[k] = 0x20;
    const i = await inspect(broken);
    // Either the content is still decodable or the check is incomplete, but it is never "decoded" to a wrong URL.
    if (i.qr.status === "decoded") expect(texts(i)).toEqual([`${URL}/STORE-001?utm_source=window&loc=001#menu`]);
    else expect(["unreadable", "not_checked"]).toContain(i.qr.status);
  });
});
