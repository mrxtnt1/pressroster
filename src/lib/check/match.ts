import type { BatchFile, OrderRow } from "./types";

/**
 * Matching key for location IDs and filename stems: outer whitespace
 * trimmed, Unicode NFC (macOS hands out decomposed filenames), and ASCII
 * letters lower-cased. Non-ASCII letters keep their case on purpose.
 */
export function matchKey(value: string): string {
  return value
    .trim()
    .normalize("NFC")
    .replace(/[A-Z]/g, (c) => c.toLowerCase());
}

export interface FileNameInfo {
  /** Basename without directories. */
  basename: string;
  /** Basename without the extension, untrimmed. */
  stem: string;
  /** Lower-cased extension without the dot, or `null`. */
  extension: string | null;
  isPdfName: boolean;
}

export function parseFileName(name: string): FileNameInfo {
  const basename = name.split(/[\\/]/).pop() ?? name;
  const pdf = /\.pdf$/i.exec(basename);
  if (pdf) {
    return { basename, stem: basename.slice(0, pdf.index), extension: "pdf", isPdfName: true };
  }
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(basename);
  if (ext && ext.index > 0) {
    return {
      basename,
      stem: basename.slice(0, ext.index),
      extension: ext[1].toLowerCase(),
      isPdfName: false,
    };
  }
  return { basename, stem: basename, extension: null, isPdfName: false };
}

export interface MatchResult {
  /** Files per location, keyed by `OrderRow.matchKey`, in batch order. */
  byLocation: Map<string, BatchFile[]>;
  unexpected: BatchFile[];
}

export function matchFiles(rows: OrderRow[], files: BatchFile[]): MatchResult {
  const byLocation = new Map<string, BatchFile[]>();
  for (const row of rows) byLocation.set(row.matchKey, []);
  const unexpected: BatchFile[] = [];
  for (const file of files) {
    const key = matchKey(parseFileName(file.name).stem);
    const bucket = byLocation.get(key);
    if (bucket) bucket.push(file);
    else unexpected.push(file);
  }
  return { byLocation, unexpected };
}

/** Strip leading zeroes from every digit run: "store-0017" → "store-17". */
function stripLeadingZeroes(key: string): string {
  return key.replace(/\d+/g, (digits) => digits.replace(/^0+(?=\d)/, ""));
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/**
 * Suggest CSV location IDs an unexpected filename was probably meant to be
 * (a missing leading zero, a one- or two-character typo). Only the closest
 * candidates are returned, and locations that have no file yet win ties, so
 * a typo like STORE-14 points at the missing STORE-104. Advisory only.
 */
export function suggestLocations(
  filename: string,
  rows: OrderRow[],
  missing: ReadonlySet<string> = new Set(),
  limit = 3,
): string[] {
  const key = matchKey(parseFileName(filename).stem);
  if (!key) return [];
  const loose = stripLeadingZeroes(key);
  const scored: { row: OrderRow; score: number }[] = [];
  for (const row of rows) {
    if (stripLeadingZeroes(row.matchKey) === loose) {
      scored.push({ row, score: 0 });
      continue;
    }
    if (Math.min(key.length, row.matchKey.length) < 4) continue;
    const distance = levenshtein(key, row.matchKey);
    if (distance <= 2) scored.push({ row, score: distance });
  }
  if (scored.length === 0) return [];
  const best = Math.min(...scored.map((s) => s.score));
  let candidates = scored.filter((s) => s.score === best).map((s) => s.row);
  const missingOnes = candidates.filter((r) => missing.has(r.matchKey));
  if (missingOnes.length > 0) candidates = missingOnes;
  return candidates.slice(0, limit).map((r) => r.locationId);
}
