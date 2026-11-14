/**
 * Generate the synthetic fixtures in `fixtures/`. The output is committed, so
 * tests never depend on this script; rerun it only to change a fixture:
 *
 *   npm run fixtures:generate
 *
 * Two independent PDF producers are used so the checker isn't only tested
 * against the library it reads with: pdf-lib (vector and raster QR codes,
 * TrimBox/Rotate/encryption cases) and Chromium's Skia PDF backend via
 * Playwright (a typical "design tool export" with embedded fonts).
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts, degrees, rgb } from "@cantoo/pdf-lib";
import type { PDFFont, PDFPage, RGB } from "@cantoo/pdf-lib";
import QRCode from "qrcode";

const ROOT = path.resolve(import.meta.dirname, "..", "fixtures");
const IN = 72;
const MM = 72 / 25.4;
const URL_BASE = "https://order.example.com/s";

type QrKind = "vector" | "raster" | "damaged";

interface QrSpec {
  text: string;
  kind: QrKind;
  /** Display position of the QR (top-left), in points from the trim corner. */
  x: number;
  y: number;
  size: number;
}

interface ArtworkSpec {
  /** Finished (trim) size as displayed, in points. */
  width: number;
  height: number;
  bleed?: number;
  /** Write a TrimBox (implied when `bleed` is set). */
  trimBox?: boolean;
  /** Store the page unrotated and add /Rotate 90 so it displays as specified. */
  rotate90?: boolean;
  title: string;
  subtitle: string;
  qrs: QrSpec[];
  accent?: RGB;
}

/**
 * Draws in "display space": origin at the top-left of the trim area,
 * y growing downwards, as the page appears once /Rotate is applied.
 */
class Painter {
  constructor(
    private page: PDFPage,
    private spec: ArtworkSpec,
  ) {}

  private get bleed() {
    return this.spec.bleed ?? 0;
  }

  /** Map a display-space rectangle to unrotated PDF user space. */
  private mapRect(x: number, y: number, w: number, h: number) {
    const b = this.bleed;
    if (this.spec.rotate90) {
      // /Rotate 90 turns the page clockwise: display right = +y, display down = +x.
      return { x: y + b, y: x + b, width: h, height: w };
    }
    return { x: x + b, y: this.spec.height + b - y - h, width: w, height: h };
  }

  rect(x: number, y: number, w: number, h: number, color: RGB) {
    this.page.drawRectangle({ ...this.mapRect(x, y, w, h), color });
  }

  text(value: string, x: number, baseline: number, size: number, font: PDFFont, color: RGB) {
    const b = this.bleed;
    if (this.spec.rotate90) {
      this.page.drawText(value, { x: baseline + b, y: x + b, size, font, color, rotate: degrees(90) });
    } else {
      this.page.drawText(value, { x: x + b, y: this.spec.height + b - baseline, size, font, color });
    }
  }

  async qr(doc: PDFDocument, spec: QrSpec) {
    const qr = QRCode.create(spec.text, { errorCorrectionLevel: "M" });
    const n = qr.modules.size;
    const quiet = 4;
    const cell = spec.size / (n + quiet * 2);
    this.rect(spec.x, spec.y, spec.size, spec.size, rgb(1, 1, 1));

    if (spec.kind === "raster") {
      const png = await QRCode.toBuffer(spec.text, { errorCorrectionLevel: "M", margin: quiet, scale: 12 });
      const image = await doc.embedPng(png);
      // QR codes decode in any orientation, so the image is not rotated.
      this.page.drawImage(image, this.mapRect(spec.x, spec.y, spec.size, spec.size));
      return;
    }

    const ink = rgb(0.05, 0.05, 0.1);
    for (let r = 0; r < n; r++) {
      let c = 0;
      while (c < n) {
        if (!qr.modules.get(r, c)) {
          c++;
          continue;
        }
        const start = c;
        while (c < n && qr.modules.get(r, c)) c++;
        this.rect(
          spec.x + (quiet + start) * cell,
          spec.y + (quiet + r) * cell,
          (c - start) * cell + 0.05,
          cell + 0.05,
          ink,
        );
      }
    }
    if (spec.kind === "damaged") {
      // A sticker over the middle 40 %: the code is still located, but too
      // much data is lost for error correction to recover it.
      const side = n * cell * 0.4;
      const offset = quiet * cell + n * cell * 0.3;
      this.rect(spec.x + offset, spec.y + offset, side, side, rgb(0.93, 0.36, 0.2));
    }
  }
}

async function drawArtwork(doc: PDFDocument, spec: ArtworkSpec) {
  const bleed = spec.bleed ?? 0;
  const mediaW = (spec.rotate90 ? spec.height : spec.width) + bleed * 2;
  const mediaH = (spec.rotate90 ? spec.width : spec.height) + bleed * 2;
  const page = doc.addPage([mediaW, mediaH]);
  if (spec.trimBox || bleed > 0) {
    page.setTrimBox(bleed, bleed, mediaW - bleed * 2, mediaH - bleed * 2);
    page.setBleedBox(0, 0, mediaW, mediaH);
  }
  if (spec.rotate90) page.setRotation(degrees(90));

  const p = new Painter(page, spec);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const accent = spec.accent ?? rgb(0.86, 0.24, 0.16);
  const { width: W, height: H } = spec;
  const u = Math.min(W, H) / 100; // layout unit

  // Background including bleed, then a header band.
  p.rect(-bleed, -bleed, W + bleed * 2, H + bleed * 2, rgb(0.99, 0.96, 0.9));
  p.rect(-bleed, -bleed, W + bleed * 2, H * 0.22 + bleed, accent);
  p.text(spec.title, 8 * u, H * 0.11, 9 * u, bold, rgb(1, 1, 1));
  p.text(spec.subtitle, 8 * u, H * 0.17, 4 * u, regular, rgb(1, 1, 1));
  p.text("Fresh every day.", 8 * u, H * 0.34, 7 * u, bold, rgb(0.15, 0.12, 0.1));
  p.text("Scan to order ahead", 8 * u, H * 0.4, 4 * u, regular, rgb(0.3, 0.25, 0.2));
  for (const qr of spec.qrs) await p.qr(doc, qr);
  return page;
}

/** Standard layout: one QR in the lower right. */
function qrAt(spec: { width: number; height: number }, text: string, kind: QrKind = "vector"): QrSpec {
  const size = Math.min(spec.width, spec.height) * 0.32;
  return { text, kind, size, x: spec.width - size - spec.width * 0.08, y: spec.height - size - spec.height * 0.08 };
}

async function pdfLibArtwork(
  spec: Omit<ArtworkSpec, "qrs"> & { qrs?: QrSpec[]; url?: string; qrKind?: QrKind },
  options: { pages?: number; objectStreams?: boolean } = {},
): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const qrs = spec.qrs ?? (spec.url ? [qrAt(spec, spec.url, spec.qrKind)] : []);
  for (let i = 0; i < (options.pages ?? 1); i++) await drawArtwork(doc, { ...spec, qrs });
  return doc.save({ useObjectStreams: options.objectStreams ?? true });
}

async function chromiumArtwork(opts: { widthMm: number; heightMm: number; title: string; url: string }) {
  const { chromium } = await import("playwright");
  const svg = await QRCode.toString(opts.url, { type: "svg", errorCorrectionLevel: "M", margin: 4 });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html><head><style>
      @page { size: ${opts.widthMm}mm ${opts.heightMm}mm; margin: 0 }
      html, body { margin: 0; width: ${opts.widthMm}mm; height: ${opts.heightMm}mm; overflow: hidden }
      body { font-family: sans-serif; background: #fdf6e8; color: #2a201a }
      header { background: #1f6f5c; color: white; padding: 18mm 14mm 10mm }
      h1 { font-size: 22mm; margin: 0 } p { font-size: 7mm; margin: 4mm 0 0 }
      .qr { position: absolute; right: 14mm; bottom: 16mm; width: 70mm; height: 70mm; background: white }
      .qr svg { width: 100%; height: 100% }
    </style></head><body>
      <header><h1>${opts.title}</h1><p>Airport Terminal 2</p></header>
      <p style="margin:14mm;font-size:12mm;font-weight:bold">Fresh every day.</p>
      <div class="qr">${svg}</div>
    </body></html>`);
    const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
    return new Uint8Array(pdf);
  } finally {
    await browser.close();
  }
}

async function encrypted(bytes: Uint8Array, userPassword: string): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  doc.encrypt({ userPassword, ownerPassword: "owner-secret", permissions: { printing: "highResolution" } });
  return doc.save();
}

async function write(rel: string, data: Uint8Array | string) {
  const file = path.join(ROOT, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
  console.log(`  ${rel}`);
}

const BOM = "﻿";
const url = (id: string) => `${URL_BASE}/${id}`;
const tabloid = { width: 11 * IN, height: 17 * IN };

async function passingBatch() {
  const dir = "batches/passing";
  const store001Url = `${url("STORE-001")}?utm_source=window&loc=001#menu`;
  await write(
    `${dir}/order.csv`,
    BOM +
      [
        "location_id,location_name,expected_qr_url,width,height,unit",
        `STORE-001,"Downtown, Main St",${store001Url},11,17,in`,
        `STORE-002,"Airport ""T2"" Kiosk",${url("STORE-002")},210,297,mm`,
        `0042,Harbor Pier,  ${url("0042")}  ,60.96,91.44,cm`,
        "",
      ].join("\r\n"),
  );
  // Vector QR, classic xref table, URL with query string and fragment.
  await write(
    `${dir}/STORE-001.pdf`,
    await pdfLibArtwork({ ...tabloid, title: "STORE-001", subtitle: "Downtown, Main St", url: store001Url }, { objectStreams: false }),
  );
  // Chromium/Skia export, A4, inline SVG QR, MediaBox only.
  await write(`${dir}/STORE-002.pdf`, await chromiumArtwork({ widthMm: 210, heightMm: 297, title: "STORE-002", url: url("STORE-002") }));
  // Trim + rotation: stored landscape 36.25 × 24.25 in with /Rotate 90 and a
  // 0.125 in bleed; the TrimBox finishes at 24 × 36 in portrait.
  await write(
    `${dir}/0042.pdf`,
    await pdfLibArtwork({
      width: 24 * IN,
      height: 36 * IN,
      bleed: 0.125 * IN,
      rotate90: true,
      title: "0042",
      subtitle: "Harbor Pier",
      url: url("0042"),
      qrKind: "raster",
      accent: rgb(0.12, 0.35, 0.6),
    }),
  );
}

async function mixedBatch() {
  const dir = "batches/mixed";
  const ids = ["STORE-101", "STORE-102", "STORE-103", "STORE-104", "STORE-105", "STORE-106", "STORE-107", "STORE-108", "STORE-109", "STORE-110", "STORE-111", "STORE-112"];
  const sizes: Record<string, string> = { "STORE-103": "24,36,in" };
  await write(
    `${dir}/order.csv`,
    ["location_id,expected_qr_url,width,height,unit", ...ids.map((id) => `${id},${url(id)},${sizes[id] ?? "11,17,in"}`), ""].join("\n"),
  );
  const art = (id: string, extra: Partial<Parameters<typeof pdfLibArtwork>[0]> = {}) =>
    pdfLibArtwork({ ...tabloid, title: id, subtitle: "Order ahead", url: url(id), ...extra });

  // Pass, matched case-insensitively.
  await write(`${dir}/store-101.pdf`, await art("STORE-101"));
  // Valid QR, wrong store: encodes STORE-103's URL.
  await write(`${dir}/STORE-102.pdf`, await art("STORE-102", { url: url("STORE-103") }));
  // Wrong finished size: 18 × 24 in (with bleed + TrimBox) instead of 24 × 36 in.
  await write(`${dir}/STORE-103.pdf`, await art("STORE-103", { width: 18 * IN, height: 24 * IN, bleed: 0.125 * IN }));
  // STORE-104 is missing; its artwork was saved with a typo instead.
  await write(`${dir}/STORE-14.pdf`, await art("STORE-104"));
  // Duplicate artwork: the second name has a stray space before ".pdf".
  await write(`${dir}/STORE-105.pdf`, await art("STORE-105"));
  await write(`${dir}/STORE-105 .pdf`, await art("STORE-105", { accent: rgb(0.4, 0.2, 0.6) }));
  // Unreadable QR: the middle of the code is covered.
  await write(`${dir}/STORE-106.pdf`, await art("STORE-106", { qrKind: "damaged" }));
  // Corrupt: a valid PDF cut off at 60 %.
  const whole = await art("STORE-107");
  await write(`${dir}/STORE-107.pdf`, whole.slice(0, Math.floor(whole.length * 0.6)));
  // Encrypted with a user password.
  await write(`${dir}/STORE-108.pdf`, await encrypted(await art("STORE-108"), "client-secret"));
  // Unsupported: two pages.
  await write(`${dir}/STORE-109.pdf`, await pdfLibArtwork({ ...tabloid, title: "STORE-109", subtitle: "Front and back", url: url("STORE-109") }, { pages: 2 }));
  // Ambiguous: the right QR plus a different one.
  const twoQr = { ...tabloid, title: "STORE-110", subtitle: "Order ahead" };
  const size = 3 * IN;
  await write(
    `${dir}/STORE-110.pdf`,
    await pdfLibArtwork({
      ...twoQr,
      qrs: [
        { text: url("STORE-110"), kind: "vector", size, x: 0.8 * IN, y: 12 * IN },
        { text: "https://app.example.com/download?ref=poster", kind: "vector", size, x: 6.8 * IN, y: 12 * IN },
      ],
    }),
  );
  // Proven size discrepancy plus a check that needs review: A4 page, no QR.
  await write(`${dir}/STORE-111.pdf`, await pdfLibArtwork({ width: 210 * MM, height: 297 * MM, title: "STORE-111", subtitle: "Order ahead" }));
  // Landscape delivery of a portrait order, 0.5 mm over: passes with a note.
  await write(
    `${dir}/STORE-112.pdf`,
    await pdfLibArtwork({ width: 17 * IN + 0.5 * MM, height: 11 * IN, title: "STORE-112", subtitle: "Order ahead", url: url("STORE-112"), qrKind: "raster" }),
  );
}

async function invalidCsvs() {
  const dir = "csv";
  const header = "location_id,expected_qr_url,width,height,unit";
  await write(`${dir}/missing-column.csv`, ["location_id,expected_qr_url,width,height", `STORE-001,${url("STORE-001")},11,17`, ""].join("\n"));
  await write(
    `${dir}/invalid-rows.csv`,
    [
      header,
      `STORE-001,${url("STORE-001")},11,17,in`,
      `STORE-002,ftp://files.example.com/STORE-002,11,17,in`,
      `STORE-003,/s/STORE-003,11,17,in`,
      `STORE-004,${url("STORE-004")},-11,17,in`,
      `STORE-005,${url("STORE-005")},11,0,in`,
      `STORE-006,${url("STORE-006")},11,17,inches`,
      `,${url("STORE-007")},11,17,in`,
      `STORE-008,${url("STORE-008")},11,17,in,extra`,
      `STORE/009,${url("STORE-009")},11,17,in`,
      `STORE-010,${url("STORE-010")},"8,5",11,in`,
      "",
    ].join("\n"),
  );
  await write(
    `${dir}/duplicate-ids.csv`,
    [header, `STORE-001,${url("STORE-001")},11,17,in`, `STORE-002,${url("STORE-002")},11,17,in`, `STORE-001,${url("STORE-001")},11,17,in`, `store-002 ,${url("STORE-002")},11,17,in`, ""].join("\n"),
  );
  await write(`${dir}/malformed-quotes.csv`, [header, `"STORE-001,${url("STORE-001")},11,17,in`, `STORE-002,${url("STORE-002")},11,17,in`, ""].join("\n"));
  await write(`${dir}/semicolons.csv`, ["location_id;expected_qr_url;width;height;unit", `STORE-001;${url("STORE-001")};11;17;in`, ""].join("\n"));
  await write(`${dir}/header-only.csv`, `${header}\n`);
  // "Café" saved as Windows-1252 (0xE9), which is not valid UTF-8.
  await write(`${dir}/windows-1252.csv`, Buffer.from(`${header}\nCAF\xE9-01,${url("CAFE-01")},11,17,in\n`, "latin1"));
}

// Only generated folders are replaced; fixtures/README.md is hand-written.
await rm(path.join(ROOT, "batches"), { recursive: true, force: true });
await rm(path.join(ROOT, "csv"), { recursive: true, force: true });
console.log("Writing fixtures:");
await passingBatch();
await mixedBatch();
await invalidCsvs();
