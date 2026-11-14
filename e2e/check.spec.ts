import path from "node:path";
import { readdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const FIXTURES = path.resolve(import.meta.dirname, "..", "fixtures");
const batchDir = (name: string) => path.join(FIXTURES, "batches", name);
const pdfsIn = (name: string) =>
  readdirSync(batchDir(name))
    .filter((f) => f.toLowerCase().endsWith(".pdf"))
    .map((f) => path.join(batchDir(name), f));

/** Fail the test on any request that leaves this origin (no CDNs, no keys). */
function guardNetwork(page: Page) {
  const external: string[] = [];
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (!["127.0.0.1", "localhost"].includes(url.hostname) && url.protocol !== "data:" && url.protocol !== "blob:") {
      external.push(req.url());
    }
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return { external, errors };
}

async function statuses(page: Page) {
  const rows = page.getByTestId("location");
  const out: Record<string, string> = {};
  for (const row of await rows.all()) {
    out[(await row.getAttribute("data-location"))!] = (await row.getAttribute("data-status"))!;
  }
  return out;
}

test("checks the mixed fixture batch chosen with the file pickers", async ({ page }) => {
  const guard = guardNetwork(page);
  await page.goto("/");
  await page.getByTestId("csv-input").setInputFiles(path.join(batchDir("mixed"), "order.csv"));
  await page.getByTestId("pdf-input").setInputFiles(pdfsIn("mixed"));
  await page.getByTestId("run").click();
  await expect(page.getByTestId("summary")).toContainText("12 locations", { timeout: 90_000 });

  expect(await statuses(page)).toEqual({
    "STORE-101": "pass",
    "STORE-102": "mismatch",
    "STORE-103": "mismatch",
    "STORE-104": "mismatch",
    "STORE-105": "mismatch",
    "STORE-106": "needs_review",
    "STORE-107": "needs_review",
    "STORE-108": "needs_review",
    "STORE-109": "needs_review",
    "STORE-110": "needs_review",
    "STORE-111": "mismatch",
    "STORE-112": "pass",
    "No matching location": "mismatch",
  });

  // A QR that scans fine but points to another store.
  const wrongQr = page.locator('[data-location="STORE-102"] [data-check="qr"]');
  await expect(wrongQr).toHaveAttribute("data-status", "mismatch");
  await expect(wrongQr.locator('[data-field="actual"]')).toHaveText("https://order.example.com/s/STORE-103");
  await expect(wrongQr.locator('[data-field="reason"]')).toContainText("points to the URL for STORE-103");

  // Damaged QR decoded in the browser path too.
  await expect(page.locator('[data-location="STORE-106"] [data-check="qr"] [data-field="actual"]')).toHaveText(
    "QR code found but unreadable",
  );
  // Wrong size measured from the TrimBox.
  await expect(page.locator('[data-location="STORE-103"] [data-check="dimensions"] [data-field="actual"]')).toHaveText(
    "18 × 24 in (457.2 × 609.6 mm) · TrimBox",
  );
  await expect(page.locator('[data-location="No matching location"] [data-field="reason"]')).toContainText(
    "Did you mean STORE-104.pdf?",
  );

  expect(guard.external).toEqual([]);
  expect(guard.errors).toEqual([]);
});

test("runs the passing sample, including trim + rotation, entirely offline", async ({ page }) => {
  const guard = guardNetwork(page);
  await page.goto("/");
  await page.getByTestId("sample-passing").click();
  await expect(page.getByTestId("summary")).toContainText("3 locations · 3 pass", { timeout: 90_000 });
  expect(await statuses(page)).toEqual({ "STORE-001": "pass", "STORE-002": "pass", "0042": "pass" });
  await expect(page.locator('[data-location="0042"] [data-check="dimensions"] [data-field="actual"]')).toHaveText(
    "60.96 × 91.44 cm (609.6 × 914.4 mm) · TrimBox · rotated 90°",
  );
  await expect(page.locator('[data-location="STORE-001"] [data-check="qr"] [data-field="actual"]')).toHaveText(
    "https://order.example.com/s/STORE-001?utm_source=window&loc=001#menu",
  );
  expect(guard.external).toEqual([]);
  expect(guard.errors).toEqual([]);
});

test("shows row-specific errors for an invalid CSV and checks nothing", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("csv-input").setInputFiles(path.join(FIXTURES, "csv", "invalid-rows.csv"));
  await page.getByTestId("pdf-input").setInputFiles(pdfsIn("passing"));
  await page.getByTestId("run").click();
  const errors = page.getByTestId("csv-error");
  await expect(errors).toHaveCount(9);
  await expect(errors.first()).toHaveText(/^Row 3: expected_qr_url .* must be an absolute http:\/\/ or https:\/\/ URL\.$/);
  await expect(page.getByTestId("csv-errors")).toContainText("Nothing was checked");
  await expect(page.getByTestId("location")).toHaveCount(0);
});

test("works at phone width without horizontal page scroll @mobile", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("sample-mixed").click();
  await expect(page.getByTestId("summary")).toContainText("12 locations", { timeout: 90_000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
