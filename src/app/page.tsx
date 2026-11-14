import { TestBench } from "./test-bench";

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      <header className="mb-8">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">PressRoster</h1>
          <span className="rounded-full border border-border px-2.5 py-0.5 text-xs text-muted">Check bench · Phase 1</span>
        </div>
        <p className="mt-1 text-lg text-muted">Every location. The right file.</p>
        <p className="mt-3 max-w-3xl text-sm text-muted">
          Choose the client&apos;s order CSV and the batch of production PDFs. Each PDF is matched to a location by
          filename, then its finished size and QR destination are compared with the order. Files are checked in this
          browser and are never uploaded.
        </p>
      </header>
      <TestBench />
    </main>
  );
}
