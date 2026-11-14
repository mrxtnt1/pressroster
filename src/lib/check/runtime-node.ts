/**
 * Node runtime for the checker: used by the test suite and the CLI.
 * Uses the same pdf.js legacy build and zxing-wasm reader as the browser,
 * with @napi-rs/canvas standing in for <canvas>. Fully offline.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import type { CheckRuntime, PdfjsModule, RawQrResult, RgbaImage } from "./types";
import { QR_READER_OPTIONS, toRawQrResults } from "./qr";

const require = createRequire(import.meta.url);
const pdfjsRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
const dir = (name: string) => path.join(pdfjsRoot, name) + path.sep;

let pdfjsPromise: Promise<PdfjsModule> | null = null;
let zxingReady: Promise<unknown> | null = null;

export function createNodeRuntime(): CheckRuntime {
  return {
    loadPdfjs() {
      pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs");
      return pdfjsPromise;
    },
    documentOptions: {
      standardFontDataUrl: dir("standard_fonts"),
      cMapUrl: dir("cmaps"),
      cMapPacked: true,
      wasmUrl: dir("wasm"),
      iccUrl: dir("iccs"),
      disableFontFace: true,
      useSystemFonts: false,
    },
    createCanvas(width, height) {
      let canvas: Canvas | null = createCanvas(width, height);
      return {
        canvas,
        getImageData(): RgbaImage {
          const image = canvas!.getContext("2d").getImageData(0, 0, width, height);
          return { data: image.data, width: image.width, height: image.height, colorSpace: "srgb" };
        },
        dispose() {
          if (canvas) {
            canvas.width = 0;
            canvas.height = 0;
          }
          canvas = null;
        },
      };
    },
    async decodeQr(image: RgbaImage): Promise<RawQrResult[]> {
      zxingReady ??= prepareZXingModule({
        overrides: {
          wasmBinary: readFileSync(require.resolve("zxing-wasm/reader/zxing_reader.wasm")).buffer,
        },
        fireImmediately: true,
      });
      await zxingReady;
      const results = await readBarcodes(image as ImageData, QR_READER_OPTIONS);
      return toRawQrResults(results);
    },
  };
}
