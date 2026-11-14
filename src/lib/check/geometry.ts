import { PDFArray, PDFDocument, PDFName, PDFNumber, ParseSpeeds } from "@cantoo/pdf-lib";
import type { PDFObject, PDFPageLeaf } from "@cantoo/pdf-lib";
import { MM_PER_POINT } from "./units";
import type { GeometryResult, PdfBox, SizeSource } from "./types";

export interface StructureResult {
  ok: true;
  pageCount: number;
  encrypted: boolean;
  /** Geometry of page 1. */
  geometry: GeometryResult;
}

/**
 * Read page boxes, rotation and UserUnit with pdf-lib. pdf.js renders the
 * page but does not expose TrimBox, so the two parsers are used side by side;
 * `inspect.ts` treats a disagreement between them as "Needs review".
 */
export async function readStructure(
  bytes: Uint8Array,
): Promise<StructureResult | { ok: false; reason: string }> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
      throwOnInvalidObject: false,
      parseSpeed: ParseSpeeds.Fastest,
    });
  } catch (error) {
    return { ok: false, reason: `The PDF structure could not be parsed (${describeError(error)}).` };
  }

  let pageCount: number;
  let leaf: PDFPageLeaf | undefined;
  try {
    pageCount = doc.getPageCount();
    leaf = pageCount > 0 ? doc.getPage(0).node : undefined;
  } catch (error) {
    return { ok: false, reason: `The page tree could not be read (${describeError(error)}).` };
  }

  return {
    ok: true,
    pageCount,
    encrypted: doc.isEncrypted,
    geometry: leaf ? readPageGeometry(leaf) : { ok: false, reason: "The PDF has no pages." },
  };
}

/** Points of slack when checking that a TrimBox sits inside the page. */
const CONTAINMENT_EPSILON_PT = 0.5;

export function readPageGeometry(leaf: PDFPageLeaf): GeometryResult {
  let mediaBox: PdfBox | null;
  let cropBox: PdfBox | null = null;
  let trimBox: PdfBox | null = null;
  let rotation: 0 | 90 | 180 | 270;
  let userUnit = 1;

  try {
    mediaBox = toBox(leaf.MediaBox(), leaf);
    if (!mediaBox) return { ok: false, reason: "The page has no valid MediaBox." };

    const cropRaw = leaf.CropBox();
    if (cropRaw) {
      // Like PDF viewers, an invalid CropBox is ignored and the CropBox is
      // clipped to the MediaBox.
      const parsed = toBox(cropRaw, leaf);
      cropBox = parsed ? intersect(parsed, mediaBox) : null;
    }

    const trimRaw = leaf.TrimBox();
    if (trimRaw) {
      trimBox = toBox(trimRaw, leaf);
      if (!trimBox) {
        return { ok: false, reason: "The page has a TrimBox, but it is malformed or has no area." };
      }
      const page = cropBox ?? mediaBox;
      if (!contains(page, trimBox, CONTAINMENT_EPSILON_PT)) {
        return {
          ok: false,
          reason: `The TrimBox extends beyond the page's ${cropBox ? "CropBox" : "MediaBox"}, so the finished size is ambiguous.`,
        };
      }
    }

    const rotate = leaf.Rotate()?.asNumber() ?? 0;
    // pdf.js and Acrobat treat a Rotate that isn't a multiple of 90 as 0.
    const normalized = Number.isInteger(rotate) && rotate % 90 === 0 ? ((rotate % 360) + 360) % 360 : 0;
    rotation = normalized as 0 | 90 | 180 | 270;

    const unit = leaf.lookup(PDFName.of("UserUnit"));
    if (unit instanceof PDFNumber) {
      const value = unit.asNumber();
      if (!(value > 0) || !Number.isFinite(value)) {
        return { ok: false, reason: `The page has an invalid UserUnit (${value}).` };
      }
      userUnit = value;
    }
  } catch (error) {
    return { ok: false, reason: `The page boxes could not be read (${describeError(error)}).` };
  }

  const source: SizeSource = trimBox ? "TrimBox" : cropBox ? "CropBox" : "MediaBox";
  const box = trimBox ?? cropBox ?? mediaBox;
  let widthMm = (box.x1 - box.x0) * userUnit * MM_PER_POINT;
  let heightMm = (box.y1 - box.y0) * userUnit * MM_PER_POINT;
  if (rotation === 90 || rotation === 270) [widthMm, heightMm] = [heightMm, widthMm];

  return {
    ok: true,
    source,
    widthMm,
    heightMm,
    rotation,
    userUnit,
    boxes: { mediaBox, cropBox, trimBox },
  };
}

function toBox(array: PDFArray | undefined, leaf: PDFPageLeaf): PdfBox | null {
  if (!(array instanceof PDFArray) || array.size() !== 4) return null;
  const values: number[] = [];
  for (let i = 0; i < 4; i++) {
    const item: PDFObject | undefined = leaf.context.lookup(array.get(i));
    if (!(item instanceof PDFNumber)) return null;
    const n = item.asNumber();
    if (!Number.isFinite(n)) return null;
    values.push(n);
  }
  const [a, b, c, d] = values;
  const box = { x0: Math.min(a, c), y0: Math.min(b, d), x1: Math.max(a, c), y1: Math.max(b, d) };
  return box.x1 - box.x0 > 0 && box.y1 - box.y0 > 0 ? box : null;
}

function intersect(a: PdfBox, b: PdfBox): PdfBox | null {
  const box = {
    x0: Math.max(a.x0, b.x0),
    y0: Math.max(a.y0, b.y0),
    x1: Math.min(a.x1, b.x1),
    y1: Math.min(a.y1, b.y1),
  };
  return box.x1 > box.x0 && box.y1 > box.y0 ? box : null;
}

function contains(outer: PdfBox, inner: PdfBox, epsilon: number): boolean {
  return (
    inner.x0 >= outer.x0 - epsilon &&
    inner.y0 >= outer.y0 - epsilon &&
    inner.x1 <= outer.x1 + epsilon &&
    inner.y1 <= outer.y1 + epsilon
  );
}

/** One short line for a thrown value, without a trailing period. */
export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0].slice(0, 160).replace(/[.\s]+$/, "") || "unknown error";
}
