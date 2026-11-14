# Fixtures

Synthetic, committed test data. All files are real binary PDFs and real CSVs; the tests read them from
disk. Regenerate with `npm run fixtures:generate` (needs the Chromium that Playwright uses). Only
`batches/` and `csv/` are rewritten; this README is hand-maintained.

Two independent PDF producers are used so the checker isn't only tested against the library it reads with:

- **pdf-lib** (`@cantoo/pdf-lib`): vector and raster QR codes, TrimBox/bleed, `/Rotate`, encryption, multi-page.
- **Chromium (Skia/PDF)** via Playwright: an HTML/SVG export with embedded fonts, like a design-tool export.

The test suite also cross-checks every fixture's boxes and rotation against poppler's `pdfinfo` when installed.

## `batches/passing`: everything should pass

| File | What it proves |
| --- | --- |
| `order.csv` | UTF-8 **BOM**, **CRLF**, quoted values with commas and `""`, an extra `location_name` column, leading-zero ID `0042`, a URL padded with spaces, `in` / `mm` / `cm` units |
| `STORE-001.pdf` | 11 × 17 in, vector QR whose URL has a **query string and fragment**; classic xref table |
| `STORE-002.pdf` | A4 (210 × 297 mm) **Chromium/Skia** export with an SVG QR; MediaBox only (594.96 × 841.92 pt) |
| `0042.pdf` | **Trim + rotation**: stored as a 36.25 × 24.25 in landscape MediaBox with 0.125 in bleed, a 36 × 24 in TrimBox and `/Rotate 90`; finishes at 24 × 36 in portrait = 60.96 × 91.44 cm. Raster (PNG) QR |

## `batches/mixed`: one location per failure mode

| Location | File(s) | Scenario | Expected |
| --- | --- | --- | --- |
| STORE-101 | `store-101.pdf` | Filename differs only in case | Pass |
| STORE-102 | `STORE-102.pdf` | **QR scans fine but points to STORE-103** | Mismatch (QR) |
| STORE-103 | `STORE-103.pdf` | **Wrong finished size**: 18 × 24 in TrimBox, order says 24 × 36 in | Mismatch (size) |
| STORE-104 | none | **Missing artwork** | Mismatch (file) |
| STORE-105 | `STORE-105.pdf`, `STORE-105 .pdf` | **Duplicate match** (stray space before `.pdf`) | Mismatch (file), both files still checked |
| STORE-106 | `STORE-106.pdf` | **Unreadable QR**: middle 40 % covered | Needs review (QR) |
| STORE-107 | `STORE-107.pdf` | **Corrupt**: valid PDF truncated at 60 % | Needs review (PDF) |
| STORE-108 | `STORE-108.pdf` | **Encrypted** with a user password | Needs review (PDF, QR not checked) |
| STORE-109 | `STORE-109.pdf` | **Unsupported**: 2 pages | Needs review (size and QR not checked) |
| STORE-110 | `STORE-110.pdf` | **Ambiguous**: correct QR plus a different app-download QR | Needs review (QR) |
| STORE-111 | `STORE-111.pdf` | A4 instead of 11 × 17 in **and** no QR | Mismatch: the proven size problem stays visible next to the QR that needs review |
| STORE-112 | `STORE-112.pdf` | Delivered landscape (17 in + 0.5 mm × 11 in) for a portrait order | Pass, with an orientation note |
| none | `STORE-14.pdf` | **Unexpected file** (typo of STORE-104) | Mismatch, "Did you mean STORE-104.pdf?" |

## `csv/`: invalid orders (each must be rejected before any PDF is read)

| File | Problem |
| --- | --- |
| `missing-column.csv` | No `unit` column |
| `invalid-rows.csv` | `ftp://` URL, relative URL, negative width, zero height, `inches`, empty ID, extra column, ID with `/`, decimal comma (rows 3–11) |
| `duplicate-ids.csv` | Exact duplicate `STORE-001`, and `store-002 ` colliding with `STORE-002` |
| `malformed-quotes.csv` | Unclosed quote |
| `semicolons.csv` | Semicolon-separated export |
| `header-only.csv` | No location rows |
| `windows-1252.csv` | Not UTF-8 (`Café` saved as Windows-1252) |
