import type { ReadResult, ReaderOptions } from "zxing-wasm/reader";
import type { RawQrResult } from "./types";

/**
 * zxing-cpp reader settings shared by every runtime.
 * - Only QR codes (Micro QR and rMQR are different symbologies).
 * - `returnErrors` reports QR-like marks that fail to decode, so a damaged
 *   code is reported as unreadable rather than "no QR found".
 * - Up to 8 symbols per page so a second, different QR is never missed by
 *   stopping at the first hit.
 */
export const QR_READER_OPTIONS: ReaderOptions = {
  formats: ["QRCode"],
  tryHarder: true,
  tryRotate: true,
  tryInvert: true,
  tryDownscale: true,
  returnErrors: true,
  maxNumberOfSymbols: 8,
};

export function toRawQrResults(results: ReadResult[]): RawQrResult[] {
  return results.map((r) => ({
    isValid: r.isValid,
    text: r.text,
    error: r.error,
    corners: [r.position.topLeft, r.position.topRight, r.position.bottomRight, r.position.bottomLeft].map(
      (p) => ({ x: p.x, y: p.y }),
    ),
  }));
}
