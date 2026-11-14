import { describe, expect, it } from "vitest";
import { formatCsvError, parseOrderCsv } from "@/lib/check";
import { fixtureBytes } from "./helpers";

const HEADER = "location_id,expected_qr_url,width,height,unit";
const URL = "https://order.example.com/s";

function csv(...rows: string[]) {
  return [HEADER, ...rows].join("\n");
}

function errorsOf(input: string | Uint8Array) {
  const result = parseOrderCsv(input);
  if (result.ok) throw new Error("expected the CSV to be rejected");
  return result.errors;
}

describe("parseOrderCsv: valid input", () => {
  it("parses the passing fixture: BOM, CRLF, quoting, extra columns, leading zeroes, padded URL", async () => {
    const result = parseOrderCsv(await fixtureBytes("batches/passing/order.csv"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.columns[0]).toBe("location_id"); // BOM stripped
    expect(result.rows.map((r) => r.locationId)).toEqual(["STORE-001", "STORE-002", "0042"]);
    const [a, b, c] = result.rows;
    expect(a.extra).toEqual({ location_name: "Downtown, Main St" });
    expect(b.extra).toEqual({ location_name: 'Airport "T2" Kiosk' });
    expect(a.expectedQrUrl).toBe(`${URL}/STORE-001?utm_source=window&loc=001#menu`);
    expect(c).toMatchObject({ locationId: "0042", matchKey: "0042", width: 60.96, height: 91.44, unit: "cm", row: 4 });
    expect(c.expectedQrUrl).toBe(`${URL}/0042`); // outer whitespace trimmed
  });

  it("keeps IDs as strings and preserves query strings and fragments verbatim", () => {
    const result = parseOrderCsv(csv(`007,${URL}/x?A=1&b=%20#Frag,1,2,MM`));
    expect(result.ok && result.rows[0]).toMatchObject({
      locationId: "007",
      expectedQrUrl: `${URL}/x?A=1&b=%20#Frag`,
      unit: "mm",
    });
  });

  it("accepts header names in any case and order, and multi-line quoted extras", () => {
    const input = `Unit,Height,WIDTH,Expected_QR_URL,Location_ID,notes\nin,17,11,${URL}/A,A-1,"line one\nline two"\n`;
    const result = parseOrderCsv(input);
    expect(result.ok && result.rows[0]).toMatchObject({ locationId: "A-1", width: 11, height: 17, unit: "in" });
    expect(result.ok && result.rows[0].extra.notes).toBe("line one\nline two");
  });

  it("accepts decimals like .5 and 24.0, and skips blank lines without shifting row numbers", () => {
    const result = parseOrderCsv(csv(`A,${URL}/A,.5,24.0,in`, "", ",,,,", `B,${URL}/B,1,2,cm`));
    expect(result.ok && result.rows.map((r) => [r.locationId, r.row, r.width])).toEqual([
      ["A", 2, 0.5],
      ["B", 5, 1],
    ]);
  });
});

describe("parseOrderCsv: rejected input", () => {
  it("reports missing columns with what was found", async () => {
    const errors = errorsOf(await fixtureBytes("csv/missing-column.csv"));
    expect(errors).toHaveLength(1);
    expect(errors[0].row).toBe(1);
    expect(errors[0].message).toMatch(/Missing required column: unit\. Found: location_id/);
  });

  it("reports every malformed row with its spreadsheet row number", async () => {
    const errors = errorsOf(await fixtureBytes("csv/invalid-rows.csv"));
    const byRow = Object.fromEntries(errors.map((e) => [e.row, e]));
    expect(byRow[2]).toBeUndefined(); // STORE-001 is valid
    expect(byRow[3]).toMatchObject({ column: "expected_qr_url" }); // ftp://
    expect(byRow[3].message).toMatch(/absolute http:\/\/ or https:\/\/ URL/);
    expect(byRow[4]).toMatchObject({ column: "expected_qr_url" }); // relative
    expect(byRow[5]).toMatchObject({ column: "width" });
    expect(byRow[5].message).toMatch(/positive/);
    expect(byRow[6]).toMatchObject({ column: "height" });
    expect(byRow[7]).toMatchObject({ column: "unit" });
    expect(byRow[7].message).toMatch(/Use "in" for inches/);
    expect(byRow[8]).toMatchObject({ column: "location_id" });
    expect(byRow[9].message).toMatch(/Expected 5 values but found 6/);
    expect(byRow[10].message).toMatch(/slash/);
    expect(byRow[11].message).toMatch(/decimal comma/);
    expect(errors).toHaveLength(9);
  });

  it("rejects duplicated IDs and IDs that collide ignoring case and outer whitespace", async () => {
    const errors = errorsOf(await fixtureBytes("csv/duplicate-ids.csv"));
    expect(errors.map((e) => e.row)).toEqual([4, 5]);
    expect(errors[0].message).toBe('location_id "STORE-001" is duplicated (first used on row 2).');
    expect(errors[1].message).toMatch(/"store-002" collides with "STORE-002" on row 3/);
  });

  it("does not fold non-ASCII case, so these IDs do not collide", () => {
    expect(parseOrderCsv(csv(`ÉTÉ-1,${URL}/a,1,1,in`, `été-1,${URL}/b,1,1,in`)).ok).toBe(true);
  });

  it("reports unclosed quotes", async () => {
    const errors = errorsOf(await fixtureBytes("csv/malformed-quotes.csv"));
    expect(errors[0]).toMatchObject({ row: 2 });
    expect(errors[0].message).toMatch(/quoted value is never closed/);
  });

  it("explains semicolon-separated exports", async () => {
    expect(errorsOf(await fixtureBytes("csv/semicolons.csv"))[0].message).toMatch(/separated by semicolons/);
  });

  it("rejects a header with no rows, and an empty file", async () => {
    expect(errorsOf(await fixtureBytes("csv/header-only.csv"))[0].message).toMatch(/no location rows/);
    expect(errorsOf("")[0].message).toMatch(/empty/);
    expect(errorsOf(new Uint8Array([0xef, 0xbb, 0xbf]))[0].message).toMatch(/empty/);
  });

  it("rejects non-UTF-8 bytes instead of corrupting IDs", async () => {
    expect(errorsOf(await fixtureBytes("csv/windows-1252.csv"))[0].message).toMatch(/isn't valid UTF-8/);
  });

  it("rejects URLs with spaces or stray quotes, and units inside numbers", () => {
    const errors = errorsOf(
      csv(`A,${URL}/a b,1,1,in`, `B,${URL}/b"x,1,1,in`, `C,${URL}/c,24in,1,in`, `D,https:example.com,1,1,in`),
    );
    expect(errors.map((e) => [e.row, e.column])).toEqual([
      [2, "expected_qr_url"],
      [3, "expected_qr_url"],
      [4, "width"],
      [5, "expected_qr_url"],
    ]);
    expect(formatCsvError(errors[2])).toBe('Row 4: width "24in" includes a unit. Put only the number here and the unit in the unit column.');
  });

  it("still returns the valid rows for display when the order is rejected", () => {
    const result = parseOrderCsv(csv(`A,${URL}/a,1,1,in`, `B,nope,1,1,in`));
    expect(result.ok).toBe(false);
    expect(result.rows.map((r) => r.locationId)).toEqual(["A"]);
  });
});
