import { describe, expect, it } from "vitest";
import { matchFiles, matchKey, parseFileName, parseOrderCsv, suggestLocations } from "@/lib/check";
import { memoryFile } from "./helpers";

const rowsOf = (ids: string[]) => {
  const result = parseOrderCsv(
    ["location_id,expected_qr_url,width,height,unit", ...ids.map((id) => `${id},https://x.example/${id},1,1,in`)].join("\n"),
  );
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.rows;
};
const file = (name: string) => memoryFile(name, new Uint8Array());

describe("matchKey / parseFileName", () => {
  it("trims outer whitespace and folds ASCII case only", () => {
    expect(matchKey("  Store-017\t")).toBe("store-017");
    expect(matchKey("ÉTÉ")).toBe("ÉtÉ");
    expect(matchKey("0042")).toBe("0042");
  });

  it("normalises decomposed (macOS) filenames to NFC", () => {
    expect(matchKey("Café-1")).toBe(matchKey("Café-1"));
  });

  it("strips .pdf in any case and keeps the stem untrimmed", () => {
    expect(parseFileName("STORE-017.PDF")).toMatchObject({ stem: "STORE-017", isPdfName: true });
    expect(parseFileName("folder/sub/STORE-017 .pdf")).toMatchObject({ basename: "STORE-017 .pdf", stem: "STORE-017 " });
    expect(parseFileName("STORE-017.pdf.pdf").stem).toBe("STORE-017.pdf");
    expect(parseFileName("STORE-017.ai")).toMatchObject({ stem: "STORE-017", extension: "ai", isPdfName: false });
    expect(parseFileName("STORE.017.pdf").stem).toBe("STORE.017");
  });
});

describe("matchFiles", () => {
  it("matches the full ID ignoring case and outer whitespace; reports duplicates and unexpected files", () => {
    const rows = rowsOf(["STORE-017", "0042", "STORE-1"]);
    const { byLocation, unexpected } = matchFiles(rows, [
      file("store-017.pdf"),
      file(" STORE-017 .PDF"),
      file("42.pdf"),
      file("STORE-10.pdf"),
      file("STORE-1.pdf"),
    ]);
    expect(byLocation.get("store-017")!.map((f) => f.name)).toEqual(["store-017.pdf", " STORE-017 .PDF"]);
    expect(byLocation.get("0042")).toEqual([]); // leading zeroes are significant
    expect(byLocation.get("store-1")!.map((f) => f.name)).toEqual(["STORE-1.pdf"]); // no prefix matching
    expect(unexpected.map((f) => f.name)).toEqual(["42.pdf", "STORE-10.pdf"]);
  });
});

describe("suggestLocations", () => {
  const rows = rowsOf(["STORE-101", "STORE-102", "STORE-104", "0042"]);
  it("prefers the closest ID and, on ties, a location that has no file", () => {
    expect(suggestLocations("STORE-14.pdf", rows, new Set(["store-104"]))).toEqual(["STORE-104"]);
    expect(suggestLocations("42.pdf", rows)).toEqual(["0042"]);
    expect(suggestLocations("STORE-999.pdf", rows)).toEqual([]);
    expect(suggestLocations("menu.pdf", rows)).toEqual([]);
  });
});
