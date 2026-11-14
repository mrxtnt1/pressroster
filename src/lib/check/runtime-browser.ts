/**
 * Browser runtime for the checker. Artwork never leaves the machine: PDFs are
 * parsed, rendered and decoded locally. pdf.js and the zxing wasm binary are
 * served from this app's own /vendor folder (see scripts/copy-vendor.mjs),
 * never from a CDN, and pdf.js is loaded outside the bundler so the main
 * module and its worker are always the same version.
 */
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import { QR_READER_OPTIONS, toRawQrResults } from "./qr";
import type { CheckRuntime, PdfjsModule, RawQrResult, RgbaImage } from "./types";

let pdfjsPromise: Promise<PdfjsModule> | null = null;
let zxingReady: Promise<unknown> | null = null;

export function createBrowserRuntime(vendorBase = "/vendor"): CheckRuntime {
  const base = new URL(vendorBase.replace(/\/?$/, "/"), window.location.origin);
  const asset = (p: string) => new URL(p, base).href;

  return {
    loadPdfjs() {
      pdfjsPromise ??= (async () => {
        const pdfjs = (await import(
          /* webpackIgnore: true */ /* turbopackIgnore: true */ asset("pdfjs/pdf.min.mjs")
        )) as PdfjsModule;
        pdfjs.GlobalWorkerOptions.workerSrc = asset("pdfjs/pdf.worker.min.mjs");
        return pdfjs;
      })();
      pdfjsPromise.catch(() => {
        pdfjsPromise = null; // allow a retry after a network hiccup
      });
      return pdfjsPromise;
    },
    documentOptions: {
      standardFontDataUrl: asset("pdfjs/standard_fonts/"),
      cMapUrl: asset("pdfjs/cmaps/"),
      cMapPacked: true,
      wasmUrl: asset("pdfjs/wasm/"),
      iccUrl: asset("pdfjs/iccs/"),
    },
    createCanvas(width, height) {
      let canvas: HTMLCanvasElement | null = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      // Create the context first so pdf.js renders into a CPU-backed canvas
      // that is cheap to read back.
      const context = canvas.getContext("2d", { willReadFrequently: true, alpha: false });
      if (!context) throw new Error("This browser could not create a canvas for rendering.");
      return {
        canvas,
        getImageData(): RgbaImage {
          return context.getImageData(0, 0, width, height);
        },
        dispose() {
          // Releasing the backing store promptly matters in Safari.
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
          locateFile: (file: string, prefix: string) => (file.endsWith(".wasm") ? asset(`zxing/${file}`) : prefix + file),
        },
        fireImmediately: true,
      });
      await zxingReady;
      return toRawQrResults(await readBarcodes(image as ImageData, QR_READER_OPTIONS));
    },
  };
}
