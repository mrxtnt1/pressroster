import { describeError, readStructure } from "./geometry";
import type {
  CheckRuntime,
  CheckSettings,
  GeometryResult,
  PdfInspection,
  PdfProblem,
  QrResult,
  QrSymbol,
  RawQrResult,
} from "./types";

type PdfjsDocument = Awaited<ReturnType<Awaited<ReturnType<CheckRuntime["loadPdfjs"]>>["getDocument"]>["promise"]>;
type PdfjsPage = Awaited<ReturnType<PdfjsDocument["getPage"]>>;

export interface InspectOptions {
  /** False when the filename doesn't end in `.pdf`. */
  isPdfName: boolean;
  extension: string | null;
}

/**
 * Collect the raw facts about one production PDF: structure, finished size
 * and the decoded QR payload(s). Never throws; every failure becomes a
 * problem or a "not checked" result so the evaluation can't silently pass.
 */
export async function inspectPdf(
  bytes: Uint8Array,
  options: InspectOptions,
  runtime: CheckRuntime,
  settings: CheckSettings,
): Promise<PdfInspection> {
  const problems: PdfProblem[] = [];
  const byteLength = bytes.byteLength;

  if (!options.isPdfName) {
    problems.push({
      code: "wrong_extension",
      message: options.extension
        ? `The file is a .${options.extension}, not a .pdf. Export print-ready artwork as PDF.`
        : "The filename has no .pdf extension.",
    });
  }

  const header = findAscii(bytes, "%PDF-", 0, 1024);
  if (header < 0) {
    problems.push({ code: "not_pdf", message: describeNonPdf(bytes) });
    const reason = "Not checked: the file is not a PDF.";
    return {
      byteLength,
      pageCount: null,
      pdfVersion: null,
      problems,
      geometry: { ok: false, reason },
      qr: { status: "not_checked", reason },
    };
  }
  const version = /^%PDF-(\d\.\d)/.exec(asciiSlice(bytes, header, header + 8));
  const pdfVersion = version ? version[1] : null;

  if (findAscii(bytes, "%%EOF", Math.max(0, byteLength - 2048), byteLength) < 0) {
    problems.push({
      code: "truncated",
      message: "The file has no end-of-file marker, so it is probably truncated or was not fully copied.",
    });
  }

  // Parser 1: pdf-lib for boxes, rotation, UserUnit and encryption.
  const structure = await readStructure(bytes);

  // Parser 2: pdf.js for page count cross-checks and rendering.
  let doc: PdfjsDocument | null = null;
  let task: { destroy(): Promise<void> } | null = null;
  let pdfjsFailure: string | null = null;
  try {
    const pdfjs = await runtime.loadPdfjs();
    const loading = pdfjs.getDocument({
      ...runtime.documentOptions,
      // pdf.js may transfer the buffer to its worker; keep ours intact.
      data: bytes.slice(),
      password: "",
      enableXfa: false,
      stopAtErrors: false,
      verbosity: 0,
    });
    task = loading;
    doc = await loading.promise;
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "PasswordException") {
      problems.push({
        code: "password_protected",
        message: "The PDF needs a password to open, so it can't be checked or printed as-is.",
      });
      pdfjsFailure = "the PDF is password-protected";
    } else {
      problems.push({
        code: "corrupt",
        message: `The PDF is damaged and can't be opened (${describeError(error)}).`,
      });
      pdfjsFailure = "the PDF can't be opened";
    }
  }

  try {
    if (structure.ok && structure.encrypted && !problems.some((p) => p.code === "password_protected")) {
      problems.push({
        code: "encrypted",
        message: "The PDF is encrypted. Permissions may block printing or editing; ask for an unsecured file.",
      });
    }
    if (!structure.ok && doc) {
      problems.push({ code: "corrupt", message: structure.reason });
    }

    const pageCount = doc ? doc.numPages : structure.ok ? structure.pageCount : null;
    if (doc && structure.ok && structure.pageCount !== doc.numPages) {
      problems.push({
        code: "corrupt",
        message: `The PDF's page tree is inconsistent (${structure.pageCount} vs ${doc.numPages} pages).`,
      });
    }
    if (pageCount === 0) {
      problems.push({ code: "no_pages", message: "The PDF has no pages." });
    } else if (pageCount !== null && pageCount > 1) {
      problems.push({
        code: "multi_page",
        message: `The PDF has ${pageCount} pages. Each location needs one single-page, full-size PDF.`,
      });
    }

    const singlePage = pageCount === 1;
    const notSinglePage =
      pageCount === null
        ? null
        : pageCount === 0
          ? "Not checked: the PDF has no pages."
          : `Not checked: the PDF has ${pageCount} pages.`;

    let page: PdfjsPage | null = null;
    if (doc && singlePage) {
      try {
        page = await doc.getPage(1);
      } catch (error) {
        problems.push({ code: "corrupt", message: `Page 1 can't be read (${describeError(error)}).` });
      }
    }

    // Finished size.
    let geometry: GeometryResult;
    if (!singlePage) {
      geometry = {
        ok: false,
        reason: notSinglePage ?? `Not checked: ${pdfjsFailure ?? "the PDF can't be opened"}.`,
      };
    } else if (!structure.ok) {
      geometry = { ok: false, reason: `Not checked: ${lowerFirst(structure.reason)}` };
    } else {
      geometry = structure.geometry;
      if (geometry.ok && page) geometry = crossCheckGeometry(geometry, page);
    }

    // QR destination.
    let qr: QrResult;
    if (!singlePage) {
      qr = {
        status: "not_checked",
        reason: notSinglePage ?? `Not checked: ${pdfjsFailure ?? "the PDF can't be opened"}.`,
      };
    } else if (!page) {
      qr = { status: "not_checked", reason: `Not checked: ${pdfjsFailure ?? "page 1 can't be read"}.` };
    } else {
      try {
        qr = await decodePageQr(page, runtime, settings);
      } catch (error) {
        problems.push({
          code: "render_failed",
          message: `The page could not be rendered (${describeError(error)}).`,
        });
        qr = { status: "not_checked", reason: "Not checked: the page could not be rendered." };
      }
    }

    return { byteLength, pageCount, pdfVersion, problems, geometry, qr };
  } finally {
    await task?.destroy().catch(() => undefined);
  }
}

/**
 * pdf-lib supplies the boxes; pdf.js independently reports rotation,
 * UserUnit and the visible page area. If they disagree, the size isn't
 * trustworthy.
 */
function crossCheckGeometry(geometry: Extract<GeometryResult, { ok: true }>, page: PdfjsPage): GeometryResult {
  if (page.rotate !== geometry.rotation) {
    return {
      ok: false,
      reason: `Needs review: PDF readers disagree on page rotation (${geometry.rotation}° vs ${page.rotate}°).`,
    };
  }
  if (Math.abs(page.userUnit - geometry.userUnit) > 1e-6) {
    return { ok: false, reason: "Needs review: PDF readers disagree on the page's UserUnit." };
  }
  const visible = geometry.boxes.cropBox ?? geometry.boxes.mediaBox;
  const [x0, y0, x1, y1] = page.view;
  const tolerance = 0.5; // points
  if (
    Math.abs(x1 - x0 - (visible.x1 - visible.x0)) > tolerance ||
    Math.abs(y1 - y0 - (visible.y1 - visible.y0)) > tolerance
  ) {
    return { ok: false, reason: "Needs review: PDF readers disagree on the page size." };
  }
  return geometry;
}

/** Render the page at increasing detail until a QR decodes. */
async function decodePageQr(page: PdfjsPage, runtime: CheckRuntime, settings: CheckSettings): Promise<QrResult> {
  const base = page.getViewport({ scale: 1 }); // 72 px per inch × UserUnit, rotation applied
  const tried: number[] = [];
  let mostUnreadable = 0;

  for (const dpi of settings.qrDpis) {
    let scale = dpi / 72;
    const pixels = base.width * scale * base.height * scale;
    if (pixels > settings.maxRenderPixels) scale *= Math.sqrt(settings.maxRenderPixels / pixels);
    if (tried.some((s) => Math.abs(s - scale) / s < 0.05)) continue;
    tried.push(scale);

    const viewport = page.getViewport({ scale });
    const width = Math.max(1, Math.floor(viewport.width));
    const height = Math.max(1, Math.floor(viewport.height));
    const surface = runtime.createCanvas(width, height);
    let raw: RawQrResult[];
    try {
      await page.render({
        canvas: surface.canvas as HTMLCanvasElement,
        viewport,
        intent: "print",
        background: "rgb(255,255,255)",
      }).promise;
      raw = await runtime.decodeQr(surface.getImageData());
    } finally {
      surface.dispose();
      page.cleanup();
    }

    const valid = raw.filter((r) => r.isValid);
    const symbols: QrSymbol[] = valid.map((r) => ({
      text: r.text,
      corners: r.corners.map((p) => ({ x: p.x / width, y: p.y / height })),
    }));
    // A failed read that overlaps a successful (or already counted) one is
    // the same symbol seen twice.
    const seen = symbols.map((s) => s.corners);
    let unreadable = 0;
    for (const r of raw) {
      if (r.isValid) continue;
      const corners = r.corners.map((p) => ({ x: p.x / width, y: p.y / height }));
      if (seen.some((c) => overlaps(c, corners))) continue;
      seen.push(corners);
      unreadable += 1;
    }
    const effectiveDpi = Math.round(scale * 72);

    if (symbols.length > 0) {
      return { status: "decoded", symbols, unreadable, dpi: effectiveDpi };
    }
    mostUnreadable = Math.max(mostUnreadable, unreadable);
  }

  return {
    status: "unreadable",
    unreadable: mostUnreadable,
    dpis: tried.map((s) => Math.round(s * 72)),
  };
}

function overlaps(a: { x: number; y: number }[], b: { x: number; y: number }[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const box = (pts: { x: number; y: number }[]) => ({
    x0: Math.min(...pts.map((p) => p.x)),
    y0: Math.min(...pts.map((p) => p.y)),
    x1: Math.max(...pts.map((p) => p.x)),
    y1: Math.max(...pts.map((p) => p.y)),
  });
  const ba = box(a);
  const bb = box(b);
  return ba.x0 < bb.x1 && bb.x0 < ba.x1 && ba.y0 < bb.y1 && bb.y0 < ba.y1;
}

function findAscii(bytes: Uint8Array, needle: string, from: number, to: number): number {
  const end = Math.min(to, bytes.length) - needle.length;
  outer: for (let i = Math.max(0, from); i <= end; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
    }
    return i;
  }
  return -1;
}

function asciiSlice(bytes: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...bytes.subarray(from, Math.min(to, bytes.length)));
}

function describeNonPdf(bytes: Uint8Array): string {
  if (bytes.length === 0) return "The file is empty (0 bytes).";
  const start = asciiSlice(bytes, 0, 16);
  const kind =
    start.startsWith("\x89PNG")
      ? "a PNG image"
      : start.startsWith("\xff\xd8\xff")
        ? "a JPEG image"
        : start.startsWith("PK\x03\x04")
          ? "a ZIP archive"
          : start.startsWith("%!PS")
            ? "a PostScript/EPS file"
            : /^\s*</.test(start)
              ? "an HTML or XML document"
              : null;
  return kind
    ? `The file is ${kind}, not a PDF.`
    : "The file does not start with a PDF header, so it is not a PDF or is badly damaged.";
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
