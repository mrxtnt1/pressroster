/**
 * Finished-size measurement on real PDFs: page boxes, rotation (direct and
 * inherited), UserUnit, and malformed boxes. Each PDF is built in memory and
 * goes through the full inspection, so pdf.js cross-checks pdf-lib's reading.
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { PDFArray, PDFDocument, PDFName, PDFNumber, degrees } from "@cantoo/pdf-lib";
import type { PDFPage } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, inspectPdf, type GeometryResult } from "@/lib/check";
import { FIXTURES, fixtureBytes, runtime } from "./helpers";

const IN = 72;
const fast = { ...DEFAULT_SETTINGS, qrDpis: [36] }; // geometry only; skip detailed QR passes

async function build(setup: (page: PDFPage, doc: PDFDocument) => void, size: [number, number] = [11 * IN, 17 * IN]) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage(size);
  setup(page, doc);
  return doc.save();
}

async function geometryOf(bytes: Uint8Array): Promise<GeometryResult> {
  return (await inspectPdf(bytes, { isPdfName: true, extension: "pdf" }, runtime, fast)).geometry;
}

const mm = (inches: number) => +(inches * 25.4).toFixed(3);

describe("finished size from page boxes", () => {
  it("uses the MediaBox when there is no TrimBox or CropBox", async () => {
    const g = await geometryOf(await build(() => {}));
    expect(g).toMatchObject({ ok: true, source: "MediaBox", rotation: 0 });
    if (g.ok) {
      expect(g.widthMm).toBeCloseTo(mm(11), 6);
      expect(g.heightMm).toBeCloseTo(mm(17), 6);
    }
  });

  it("uses the CropBox as the page size when present", async () => {
    const g = await geometryOf(await build((p) => p.setCropBox(36, 36, 8 * IN, 10 * IN)));
    expect(g).toMatchObject({ ok: true, source: "CropBox" });
    if (g.ok) expect([g.widthMm, g.heightMm].map((v) => +v.toFixed(3))).toEqual([mm(8), mm(10)]);
  });

  it("prefers the TrimBox over a larger bleed MediaBox", async () => {
    const g = await geometryOf(
      await build((p) => p.setTrimBox(9, 9, 11 * IN, 17 * IN), [11 * IN + 18, 17 * IN + 18]),
    );
    expect(g).toMatchObject({ ok: true, source: "TrimBox" });
    if (g.ok) expect([g.widthMm, g.heightMm].map((v) => +v.toFixed(3))).toEqual([mm(11), mm(17)]);
  });

  it("normalises a TrimBox written with reversed corners", async () => {
    const g = await geometryOf(
      await build((p) => p.node.set(PDFName.of("TrimBox"), p.doc.context.obj([11 * IN, 17 * IN, 0, 0]))),
    );
    expect(g.ok && [g.source, +g.widthMm.toFixed(3)]).toEqual(["TrimBox", mm(11)]);
  });

  it.each([
    [90, true],
    [180, false],
    [270, true],
    [-90, true],
  ])("applies /Rotate %i (swap width/height: %s)", async (angle, swapped) => {
    const g = await geometryOf(await build((p) => p.setRotation(degrees(angle))));
    expect(g).toMatchObject({ ok: true, rotation: ((angle % 360) + 360) % 360 });
    if (g.ok) expect(+g.widthMm.toFixed(3)).toBe(swapped ? mm(17) : mm(11));
  });

  it("applies a /Rotate inherited from the page tree", async () => {
    const g = await geometryOf(
      await build((_, doc) => doc.catalog.Pages().set(PDFName.of("Rotate"), PDFNumber.of(90))),
    );
    expect(g).toMatchObject({ ok: true, rotation: 90 });
    if (g.ok) expect(+g.widthMm.toFixed(3)).toBe(mm(17));
  });

  it("scales by UserUnit (large-format PDFs)", async () => {
    const g = await geometryOf(
      await build((p) => p.node.set(PDFName.of("UserUnit"), PDFNumber.of(10)), [100, 200]),
    );
    expect(g).toMatchObject({ ok: true, userUnit: 10 });
    if (g.ok) expect([g.widthMm, g.heightMm].map((v) => +v.toFixed(3))).toEqual([mm(1000 / 72), mm(2000 / 72)].map((v) => +v.toFixed(3)));
  });
});

describe("boxes that make the size uncertain", () => {
  it("does not measure a malformed TrimBox", async () => {
    const g = await geometryOf(
      await build((p) => p.node.set(PDFName.of("TrimBox"), p.doc.context.obj([0, 0, 100]))),
    );
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toMatch(/TrimBox, but it is malformed/);
  });

  it("does not measure a zero-area TrimBox", async () => {
    const g = await geometryOf(await build((p) => p.setTrimBox(10, 10, 0, 100)));
    expect(g.ok).toBe(false);
  });

  it("does not measure a TrimBox that extends beyond the page", async () => {
    const g = await geometryOf(await build((p) => p.setTrimBox(-36, 0, 12 * IN, 17 * IN)));
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toMatch(/extends beyond the page's MediaBox/);
  });

  it("rejects a non-numeric MediaBox entry", async () => {
    const g = await geometryOf(
      await build((p) => {
        const box = p.node.MediaBox() as PDFArray;
        box.set(2, PDFName.of("Wide"));
      }),
    );
    expect(g.ok).toBe(false);
  });
});

// Independent check: poppler (not pdf-lib, not pdf.js) must agree with the
// boxes and rotation we read from every committed fixture.
const hasPdfinfo = (() => {
  try {
    execFileSync("pdfinfo", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasPdfinfo)("fixtures agree with poppler's pdfinfo", () => {
  const files = ["passing", "mixed"].flatMap((batch) =>
    readdirSync(path.join(FIXTURES, "batches", batch))
      .filter((n) => n.endsWith(".pdf"))
      .map((n) => `batches/${batch}/${n}`),
  );
  const skip = new Set(["batches/mixed/STORE-107.pdf", "batches/mixed/STORE-108.pdf"]); // truncated / password

  it.each(files.filter((f) => !skip.has(f)))("%s", async (rel) => {
    const out = execFileSync("pdfinfo", ["-box", "-f", "1", "-l", "1", path.join(FIXTURES, rel)], { encoding: "utf8" });
    const box = (name: string) => {
      const m = new RegExp(`Page\\s+1\\s+${name}:\\s+([-\\d.]+)\\s+([-\\d.]+)\\s+([-\\d.]+)\\s+([-\\d.]+)`).exec(out);
      return m ? [Number(m[3]) - Number(m[1]), Number(m[4]) - Number(m[2])] : null;
    };
    const rot = Number(/Page\s+1\s+rot:\s+(\d+)/.exec(out)?.[1] ?? 0);
    const trim = box("TrimBox")!;
    const [w, h] = rot % 180 === 0 ? trim : [trim[1], trim[0]];

    const inspection = await inspectPdf(await fixtureBytes(rel), { isPdfName: true, extension: "pdf" }, runtime, fast);
    if (inspection.pageCount !== 1) return; // multi-page PDFs aren't measured
    expect(inspection.geometry.ok).toBe(true);
    if (!inspection.geometry.ok) return;
    expect(inspection.geometry.rotation).toBe(rot);
    expect(inspection.geometry.widthMm).toBeCloseTo((w * 25.4) / 72, 2);
    expect(inspection.geometry.heightMm).toBeCloseTo((h * 25.4) / 72, 2);
  });
});
