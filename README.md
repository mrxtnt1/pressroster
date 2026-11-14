# PressRoster

**Every location. The right file.**

PressRoster is for sign and print shops that produce location-specific artwork for restaurant and retail chains. A
print manager picks the client's order CSV and a batch of production PDFs. PressRoster compares the batch to the
order and reports exactly which location has the **wrong QR destination**, **wrong finished dimensions**, **missing
artwork** or **duplicate artwork**. A QR code can scan successfully and still point to the wrong location.

Files are checked **in the browser**. Artwork is never uploaded, and the app runs locally with no API keys or
external services.

## Quick start

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:3000. Click **Every failure mode** to run the sample batch, or pick your own `order.csv` and
PDFs. Requires Node.js ≥ 22.13 (pdf.js 6 requirement).

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server (copies pdf.js / zxing assets to `public/vendor` first) |
| `npm run build` / `npm start` | Production build / serve it |
| `npm run lint` | ESLint (Next.js core-web-vitals + TypeScript rules) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest: unit tests plus integration tests that render and decode the real fixture PDFs in Node |
| `npm run test:e2e` | Playwright: builds, starts `next start`, checks the fixtures in Chromium (desktop + phone) |
| `npm run check -- <folder>` | CLI: same engine on a folder with `order.csv` + PDFs (`--json` for machine output; exit 0 all pass, 1 problems, 2 bad CSV) |
| `npm run fixtures:generate` | Rebuild `fixtures/` (only needed to change a fixture) |

First-time Playwright on a new machine: `npx playwright install chromium`.

## How the checks work

### Order CSV

- Required columns (any order, case-insensitive): `location_id`, `expected_qr_url`, `width`, `height`, `unit`.
  Extra columns are kept for display.
- UTF-8 with or without a BOM, CRLF or LF, RFC 4180 quoting (commas, `""` and line breaks inside quotes).
  Non-UTF-8 files are rejected with Excel/Sheets export instructions instead of being silently mis-decoded.
- `location_id` is always a string, so `0042` stays `0042`. Outer whitespace is trimmed. It may not contain `/`,
  `\`, `"` or control characters.
- `expected_qr_url` must be an absolute `http://` or `https://` URL with a host and no spaces. It is stored
  trimmed but never normalised, so query strings, fragments and case are preserved.
- `width` / `height` must be positive plain numbers (`24`, `24.5`, `.5`). `unit` is `mm`, `cm` or `in`.
- Every problem is reported with its spreadsheet row number (header = row 1). That covers malformed rows, wrong
  column counts, bad quoting, duplicate IDs, and IDs that collide when compared ignoring ASCII case and outer
  whitespace (`STORE-1` vs `store-1 `). **Any CSV error stops the run before a PDF is read**: checking a partial
  order could let a dropped location look complete.

### Matching files to locations

The filename stem (`STORE-017` in `STORE-017.pdf`) is compared with the full location ID after trimming outer
whitespace, Unicode NFC normalisation (macOS hands out decomposed names), and ignoring **ASCII** case only. There is
no prefix or numeric matching: `42.pdf` does not match `0042`. The report shows:

- **Missing artwork**: a location with no file.
- **Duplicate artwork**: a location matched by two or more files. Every duplicate is still fully checked.
- **Unexpected file**: a file with no CSV match, with a "Did you mean…?" suggestion for near misses (missing
  leading zeroes, one- or two-character typos; locations that have no file yet are preferred).

### Per-file checks

Each matched file gets exactly four findings: **file**, **pdf**, **dimensions** and **qr**. Each finding has the
location ID, filename, check, status, expected value, actual value and reason.

| Check | Pass | Mismatch | Needs review |
| --- | --- | --- | --- |
| file | One file matches | Duplicate, missing, or unexpected | n/a |
| pdf | Opens, single page | n/a | Not a PDF, truncated (no `%%EOF`), damaged, password-protected, encrypted, multi-page, no pages, not named `.pdf` |
| dimensions | Within tolerance | Outside tolerance | Not measurable (malformed/oversized TrimBox, parsers disagree, multi-page, unreadable) |
| qr | Decoded text equals expected URL | Decodes to a different URL (and says which location that URL belongs to) | Nothing readable, a damaged code, two different codes where one matches, or not checked |

**Finished size.** Measured from the page **TrimBox** when present, otherwise the **CropBox**, otherwise the
**MediaBox**. The box used is reported. `/Rotate` (including inherited), `UserUnit` and unit conversion are
applied. **Pilot default: ±1 mm per edge.** With the default `orientation: "either"`, a 36 × 24 page satisfies a
24 × 36 order and the reason notes the swap; `"strict"` makes that a mismatch. Two independent parsers are used:
pdf-lib reads the boxes (pdf.js does not expose TrimBox), and pdf.js cross-checks rotation, UserUnit and the
visible page size. If they disagree, the result is Needs review.

**QR destination.** The page is rendered with pdf.js at print intent and decoded with zxing-cpp (WebAssembly). Up to
three passes run (200, 300 and 100 DPI), each capped at 16 MP so large-format signs stay within browser canvas
limits. The decoded text is compared with the CSV value after trimming outer whitespace, as an exact string. The
URL is never opened. Hints call out near misses (letter case, trailing slash, query/fragment only). All QR codes on
the page are collected, so a second, different code is reported rather than ignored.

**Status roll-up.** Mismatch beats Needs review, which beats Pass. A location passes only if every required check
passed. **An incomplete check is never Pass**, and a proven discrepancy stays visible even when another check needs
review.

### Settings (pilot defaults, in `src/lib/check/types.ts`)

| Setting | Default |
| --- | --- |
| `toleranceMm` | `1` |
| `orientation` | `"either"` |
| `qrDpis` | `[200, 300, 100]` |
| `maxRenderPixels` | `16_000_000` |

## Architecture

```
src/lib/check/            isomorphic engine (browser + Node)
  csv.ts                  order CSV parsing/validation (papaparse)
  match.ts                filename ↔ location matching, suggestions
  geometry.ts             page boxes / rotation / UserUnit / encryption (@cantoo/pdf-lib)
  inspect.ts              raw facts per PDF: preflight, geometry, render + QR decode (pdf.js + zxing-wasm)
  evaluate.ts             rules: facts + order row → findings
  batch.ts                orchestration, roll-up, summary
  runtime-browser.ts      pdf.js + zxing from /vendor, <canvas>
  runtime-node.ts         pdf.js legacy + @napi-rs/canvas + zxing wasm from node_modules (tests, CLI)
src/app/                  Next.js App Router UI (Phase 1: a minimal check bench)
scripts/                  copy-vendor (assets → public/), generate-fixtures, check-batch CLI
fixtures/                 committed binary PDF + CSV fixtures (see fixtures/README.md)
tests/                    Vitest (unit + real-PDF integration)
e2e/                      Playwright against the production build
```

Library choices (all actively maintained, permissive licences):

- **pdfjs-dist 6**: rendering. Uses the legacy build in both browser and Node for one code path, and is loaded
  from `/vendor` outside the bundler so the module and its worker always match.
- **@cantoo/pdf-lib**: maintained fork of pdf-lib, used for boxes and encryption.
- **zxing-wasm 3**: zxing-cpp QR decoding. Its `.wasm` is served locally rather than from the default CDN.
- **papaparse**: CSV parsing.
- **@napi-rs/canvas** (dev only): Node canvas for tests and the CLI.

## Progress

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Prove the checks with real files: CSV parser, rules-based PDF checker, fixtures, test harness, minimal browser test page | ✅ Done |
| 2 | Print-manager workflow UI: drag-and-drop files and folders, per-file progress, results grouped by location with filters and search, responsive cards on phones, checks moved to a Web Worker with cancel | Next |
| 3 | Shareable output: CSV and print-friendly report export, page thumbnails with the QR highlighted, tolerance and orientation settings, CSV template download | Planned |
| 4 | Accounts and history (Supabase): sign-in, clients, saved orders, run history that stores findings but never artwork. Local mode keeps working without keys | Planned |
| 5 | Hardening: tiled QR scan for very small codes on large signs, memory limits on big batches, CSP and security headers, error reporting hooks, deployment guide | Planned |

### Phase 1 checkpoint (2026-11-14)

What works:

- The order CSV is parsed and validated, with row-specific errors for every rule above.
- Filename matching reports missing, duplicate and unexpected files, with typo suggestions.
- Finished size comes from TrimBox → CropBox → MediaBox, with rotation (direct or inherited), UserUnit, unit
  conversion, a portrait/landscape note, and the source reported.
- QR codes are rendered and decoded locally (vector, raster, and SVG via Chromium), with multi-code ambiguity and
  "found but unreadable" detection.
- Corrupt, truncated, password-protected, encrypted, multi-page and non-PDF files are reported as Needs review.
- Results are structured findings with Pass / Mismatch / Needs review roll-up. A JSON report can be downloaded,
  and a CLI runs the same engine.

Verified with:

| Command | Result |
| --- | --- |
| `npm run lint` | clean |
| `npm run typecheck` | clean |
| `npm test` | 95 tests in 6 files pass (~4 s). Includes real-PDF rendering/decoding and a poppler cross-check of every fixture |
| `npm run build` | production build succeeds (Turbopack, static `/`) |
| `npm run test:e2e` | 5 Playwright tests pass against `next start`. The mixed and passing batches give the same results in Chromium as in Node, no request leaves the origin, no page errors, no horizontal scroll at phone width |

Known limits (to be addressed in later phases):

- Checks run on the main thread, one file at a time. Phase 2 moves them to a Web Worker.
- QR decoding needs about 3 px per module at the rendered DPI. A very small code on a very large sign may come back
  as Needs review (never Pass) until tiled scanning lands in Phase 5.
- Unexpected files are reported but not inspected.
- `npm audit` lists moderate advisories in dev-only tooling; production dependencies report 0 vulnerabilities.
