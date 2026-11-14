/**
 * Core types for PressRoster batch checks.
 *
 * Everything in `src/lib/check` is isomorphic: it runs unchanged in the
 * browser (the product path) and in Node (tests and the CLI). Anything that
 * touches a platform API (canvas, wasm loading, file system) is injected
 * through a {@link CheckRuntime}.
 */

export type LengthUnit = "mm" | "cm" | "in";

/** One validated row of the client order CSV. */
export interface OrderRow {
  /** 1-based spreadsheet row number (the header is row 1). */
  row: number;
  /** Location ID exactly as written in the CSV, with outer whitespace trimmed. */
  locationId: string;
  /** Matching key: trimmed, Unicode NFC, ASCII letters lower-cased. */
  matchKey: string;
  /** Expected QR payload with outer whitespace trimmed. Never URL-normalised. */
  expectedQrUrl: string;
  width: number;
  height: number;
  unit: LengthUnit;
  /** Any extra columns, preserved for display (e.g. `location_name`). */
  extra: Record<string, string>;
}

export interface CsvError {
  /** 1-based spreadsheet row (header = 1). `null` for file-level problems. */
  row: number | null;
  column: string | null;
  message: string;
}

export type CsvParseResult =
  | { ok: true; rows: OrderRow[]; columns: string[] }
  | { ok: false; errors: CsvError[]; rows: OrderRow[]; columns: string[] };

export type CheckName = "file" | "pdf" | "dimensions" | "qr";

export type FindingStatus = "pass" | "mismatch" | "needs_review";

export interface Finding {
  /** CSV location ID, or `null` for a file that matches no CSV row. */
  locationId: string | null;
  /** Batch filename, or `null` when the location has no file. */
  filename: string | null;
  check: CheckName;
  status: FindingStatus;
  expected: string | null;
  actual: string | null;
  reason: string;
}

/** A file handed to the checker. `bytes` is read lazily. */
export interface BatchFile {
  name: string;
  size: number;
  read(): Promise<Uint8Array>;
}

export type SizeSource = "TrimBox" | "CropBox" | "MediaBox";

export interface PdfBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type GeometryResult =
  | {
      ok: true;
      source: SizeSource;
      /** Finished width/height in mm as the page displays (rotation applied). */
      widthMm: number;
      heightMm: number;
      rotation: 0 | 90 | 180 | 270;
      userUnit: number;
      boxes: { mediaBox: PdfBox; cropBox: PdfBox | null; trimBox: PdfBox | null };
    }
  | { ok: false; reason: string };

export interface QrSymbol {
  text: string;
  /** Corner points as fractions (0–1) of the rendered page, for highlighting. */
  corners: { x: number; y: number }[];
}

export type QrResult =
  | {
      status: "decoded";
      /** Every readable QR symbol found on the page (deduplicated by position). */
      symbols: QrSymbol[];
      /** QR-like marks that were located but could not be decoded. */
      unreadable: number;
      dpi: number;
    }
  | { status: "unreadable"; unreadable: number; dpis: number[] }
  | { status: "not_checked"; reason: string };

export type PdfProblemCode =
  | "not_pdf"
  | "truncated"
  | "corrupt"
  | "password_protected"
  | "encrypted"
  | "multi_page"
  | "no_pages"
  | "wrong_extension"
  | "render_failed";

export interface PdfProblem {
  code: PdfProblemCode;
  message: string;
}

/** Raw facts about one PDF. Judgement happens later in `evaluate.ts`. */
export interface PdfInspection {
  byteLength: number;
  pageCount: number | null;
  pdfVersion: string | null;
  problems: PdfProblem[];
  geometry: GeometryResult;
  qr: QrResult;
}

export interface CheckSettings {
  /** Allowed difference per edge, in millimetres. Pilot default: 1 mm. */
  toleranceMm: number;
  /**
   * `either`: a 24 × 36 order also accepts a 36 × 24 page (reported as a
   * note). `strict`: width and height must match in the order given.
   */
  orientation: "either" | "strict";
  /** QR render passes, in DPI, tried in order until a QR is decoded. */
  qrDpis: number[];
  /** Upper bound on rendered pixels per pass (keeps memory and Safari safe). */
  maxRenderPixels: number;
}

export const DEFAULT_SETTINGS: CheckSettings = {
  toleranceMm: 1,
  orientation: "either",
  qrDpis: [200, 300, 100],
  maxRenderPixels: 16_000_000,
};

export interface FileResult {
  filename: string;
  /** Location this file matched, or `null` if unexpected. */
  locationId: string | null;
  status: FindingStatus;
  findings: Finding[];
  inspection: PdfInspection | null;
}

export interface LocationResult {
  locationId: string;
  row: number;
  expected: OrderRow;
  status: FindingStatus;
  files: FileResult[];
  /** All findings for this location, including every file's findings. */
  findings: Finding[];
}

export interface BatchSummary {
  locations: number;
  pass: number;
  mismatch: number;
  needsReview: number;
  missing: number;
  duplicates: number;
  unexpectedFiles: number;
  filesChecked: number;
}

export interface BatchReport {
  generatedAt: string;
  settings: CheckSettings;
  summary: BatchSummary;
  locations: LocationResult[];
  unexpectedFiles: FileResult[];
  /** Flat list of every finding, in report order. */
  findings: Finding[];
}

export type BatchResult =
  | { ok: true; report: BatchReport }
  | { ok: false; csvErrors: CsvError[] };

/** Platform hooks used to render a PDF page and decode QR codes. */
export interface CheckRuntime {
  /** Load pdf.js (`pdfjs-dist` legacy build) for this platform. */
  loadPdfjs(): Promise<PdfjsModule>;
  /** Extra `getDocument` options (font/wasm locations) for this platform. */
  documentOptions: Record<string, unknown>;
  /** Create a blank RGBA canvas of the given pixel size. */
  createCanvas(width: number, height: number): RuntimeCanvas;
  /** Decode QR codes from RGBA pixels. */
  decodeQr(image: RgbaImage): Promise<RawQrResult[]>;
}

export interface RuntimeCanvas {
  /** Value passed to pdf.js `render({ canvas })`. */
  canvas: unknown;
  getImageData(): RgbaImage;
  dispose(): void;
}

export interface RgbaImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  colorSpace?: string;
}

export interface RawQrResult {
  isValid: boolean;
  text: string;
  error: string;
  corners: { x: number; y: number }[];
}

/** The pdf.js module (legacy build). Type-only import; loaded per platform. */
export type PdfjsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
