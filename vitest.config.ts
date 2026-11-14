import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Real PDF rendering + wasm QR decoding; generous but bounded.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
