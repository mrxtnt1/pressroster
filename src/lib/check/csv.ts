import Papa from "papaparse";
import { matchKey } from "./match";
import type { CsvError, CsvParseResult, LengthUnit, OrderRow } from "./types";

export const REQUIRED_COLUMNS = [
  "location_id",
  "expected_qr_url",
  "width",
  "height",
  "unit",
] as const;

type RequiredColumn = (typeof REQUIRED_COLUMNS)[number];

const UNITS: readonly LengthUnit[] = ["mm", "cm", "in"];

const NOT_UTF8_MESSAGE =
  "The CSV isn't valid UTF-8 text. In Excel use File › Save As › “CSV UTF-8 (Comma delimited)”, " +
  "or in Google Sheets use File › Download › CSV.";

/**
 * Parse and validate a client order CSV.
 *
 * - Accepts UTF-8 with or without a BOM, CRLF or LF line endings, and the
 *   usual RFC 4180 quoting (commas, quotes and line breaks inside quotes).
 * - Column names are matched case-insensitively; extra columns are kept.
 * - Every problem is reported with its spreadsheet row number (header = 1),
 *   so the order can be fixed in one pass. Any error rejects the whole order:
 *   checking a partial order could let a dropped location look complete.
 */
export function parseOrderCsv(input: string | Uint8Array): CsvParseResult {
  let text: string;
  if (typeof input === "string") {
    text = input;
  } else {
    try {
      // `fatal` rejects Windows-1252 / Latin-1 exports instead of silently
      // corrupting IDs and URLs. The decoder strips a UTF-8 BOM by default.
      text = new TextDecoder("utf-8", { fatal: true }).decode(input);
    } catch {
      return fileError(NOT_UTF8_MESSAGE);
    }
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.trim() === "") return fileError("The CSV file is empty.");

  const parsed = Papa.parse<string[]>(text, {
    delimiter: ",",
    header: false,
    skipEmptyLines: false,
  });

  const errors: CsvError[] = [];
  const quoteErrorRows = new Set<number>();
  for (const err of parsed.errors) {
    const row = typeof err.row === "number" ? err.row + 1 : null;
    if (row !== null && quoteErrorRows.has(row)) continue; // one quote error per row
    if (err.code === "MissingQuotes") {
      errors.push({
        row,
        column: null,
        message:
          "A quoted value is never closed. Every opening double quote needs a closing one; " +
          "everything after this point was read as a single value.",
      });
    } else if (err.code === "InvalidQuotes") {
      errors.push({
        row,
        column: null,
        message:
          'Malformed quotes. Wrap the whole value in double quotes and write a literal quote as "".',
      });
    } else {
      errors.push({ row, column: null, message: err.message });
    }
    if (row !== null) quoteErrorRows.add(row);
  }

  const records = parsed.data;
  const headerCells = (records[0] ?? []).map((cell) => cell.trim().toLowerCase());
  const columns = (records[0] ?? []).map((cell) => cell.trim());

  if (headerCells.length === 1 && /[;\t|]/.test(headerCells[0])) {
    const sep = headerCells[0].includes(";") ? "semicolons" : headerCells[0].includes("\t") ? "tabs" : "pipes";
    return fileError(
      `The header row is separated by ${sep}. Export the order as a comma-separated CSV.`,
      columns,
    );
  }

  const index = new Map<string, number>();
  headerCells.forEach((name, i) => {
    if (name === "") return;
    if (index.has(name)) {
      errors.push({ row: 1, column: name, message: `Column "${name}" appears more than once in the header.` });
    } else {
      index.set(name, i);
    }
  });
  const missing = REQUIRED_COLUMNS.filter((c) => !index.has(c));
  if (missing.length > 0) {
    const found = columns.filter(Boolean).join(", ") || "none";
    errors.unshift({
      row: 1,
      column: null,
      message: `Missing required column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. Found: ${found}.`,
    });
    return { ok: false, errors: sortErrors(errors), rows: [], columns };
  }

  const rows: OrderRow[] = [];
  const width = headerCells.length;

  for (let i = 1; i < records.length; i++) {
    const rowNumber = i + 1;
    const cells = records[i];
    if (cells.every((cell) => cell.trim() === "")) continue; // blank line / ",,,,"
    if (quoteErrorRows.has(rowNumber)) continue; // already reported

    if (cells.length !== width) {
      errors.push({
        row: rowNumber,
        column: null,
        message:
          `Expected ${width} values but found ${cells.length}. ` +
          "Wrap values that contain commas in double quotes.",
      });
      continue;
    }

    const get = (col: RequiredColumn) => cells[index.get(col)!];
    const rowErrors: CsvError[] = [];
    const err = (column: RequiredColumn, message: string) =>
      rowErrors.push({ row: rowNumber, column, message });

    const locationId = get("location_id").trim();
    if (locationId === "") {
      err("location_id", "location_id is empty.");
    } else if (/[\\/]/.test(locationId)) {
      err("location_id", `location_id "${locationId}" contains a slash, so no filename can match it.`);
    } else if (locationId.includes('"')) {
      err("location_id", `location_id ${locationId} contains a double quote. Check the CSV quoting.`);
    } else if (/[\u0000-\u001f\u007f]/.test(locationId)) {
      err("location_id", `location_id "${locationId}" contains control characters.`);
    }

    const expectedQrUrl = get("expected_qr_url").trim();
    const urlProblem = validateUrl(expectedQrUrl);
    if (urlProblem) err("expected_qr_url", urlProblem);

    const w = parseDimension(get("width"), "width");
    if (typeof w === "string") err("width", w);
    const h = parseDimension(get("height"), "height");
    if (typeof h === "string") err("height", h);

    const unitRaw = get("unit").trim();
    const unit = unitRaw.toLowerCase();
    if (!UNITS.includes(unit as LengthUnit)) {
      const hint = /^(inch|inches|")$/.test(unit) ? ' Use "in" for inches.' : "";
      err("unit", `unit "${unitRaw}" isn't supported. Use mm, cm or in.${hint}`);
    }

    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
      continue;
    }

    const extra: Record<string, string> = {};
    headerCells.forEach((name, col) => {
      if (name && !(REQUIRED_COLUMNS as readonly string[]).includes(name)) {
        extra[columns[col]] = cells[col].trim();
      }
    });

    rows.push({
      row: rowNumber,
      locationId,
      matchKey: matchKey(locationId),
      expectedQrUrl,
      width: w as number,
      height: h as number,
      unit: unit as LengthUnit,
      extra,
    });
  }

  // Duplicate and colliding IDs. Filenames are matched ignoring ASCII case
  // and outer whitespace, so IDs that differ only that way are ambiguous.
  const firstByKey = new Map<string, OrderRow>();
  const unique: OrderRow[] = [];
  for (const row of rows) {
    const first = firstByKey.get(row.matchKey);
    if (!first) {
      firstByKey.set(row.matchKey, row);
      unique.push(row);
      continue;
    }
    errors.push({
      row: row.row,
      column: "location_id",
      message:
        first.locationId === row.locationId
          ? `location_id "${row.locationId}" is duplicated (first used on row ${first.row}).`
          : `location_id "${row.locationId}" collides with "${first.locationId}" on row ${first.row}. ` +
            "Filenames are matched ignoring letter case, so these IDs can't be told apart.",
    });
  }

  if (records.length <= 1 || (rows.length === 0 && errors.length === 0)) {
    errors.push({ row: null, column: null, message: "The CSV has a header but no location rows." });
  }

  if (errors.length > 0) {
    return { ok: false, errors: sortErrors(errors), rows: unique, columns };
  }
  return { ok: true, rows: unique, columns };
}

function validateUrl(value: string): string | null {
  if (value === "") return "expected_qr_url is empty.";
  if (/\s/.test(value)) return "expected_qr_url contains spaces. Encode spaces as %20.";
  if (value.includes('"')) {
    return "expected_qr_url contains a double quote. Check the CSV quoting around this value.";
  }
  if (!/^https?:\/\//i.test(value)) {
    return `expected_qr_url "${truncate(value)}" must be an absolute http:// or https:// URL.`;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `expected_qr_url "${truncate(value)}" isn't a valid URL.`;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "") {
    return `expected_qr_url "${truncate(value)}" must be an absolute http:// or https:// URL.`;
  }
  return null;
}

const NUMBER = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

function parseDimension(raw: string, name: "width" | "height"): number | string {
  const value = raw.trim();
  if (value === "") return `${name} is empty.`;
  if (/^\d+,\d+$/.test(value)) {
    return `${name} "${value}" uses a decimal comma. Use a dot, e.g. ${value.replace(",", ".")}.`;
  }
  if (/^\d*\.?\d+\s*(mm|cm|in|inch|inches|")$/i.test(value)) {
    return `${name} "${value}" includes a unit. Put only the number here and the unit in the unit column.`;
  }
  if (/^-/.test(value)) return `${name} "${value}" must be a positive number.`;
  if (!NUMBER.test(value)) return `${name} "${value}" isn't a number.`;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return `${name} "${value}" must be a positive number.`;
  return n;
}

function truncate(value: string, max = 60): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function fileError(message: string, columns: string[] = []): CsvParseResult {
  return { ok: false, errors: [{ row: null, column: null, message }], rows: [], columns };
}

function sortErrors(errors: CsvError[]): CsvError[] {
  return [...errors].sort((a, b) => (a.row ?? 0) - (b.row ?? 0));
}

/** "Row 4: width "abc" isn't a number." — one line for UIs and logs. */
export function formatCsvError(error: CsvError): string {
  return error.row === null ? error.message : `Row ${error.row}: ${error.message}`;
}
