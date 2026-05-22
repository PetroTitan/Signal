import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { NEVER_EXTRACT_FIELDS } from "@/core/mcp-operations";

export const dynamic = "force-dynamic";

export default function ImportsPage() {
  return (
    <>
      <Topbar
        title="Import assistant"
        description="AI-assisted product and account import. Review before save."
      />

      <div className="px-6 lg:px-10 py-8 max-w-3xl space-y-6">
        <section className="card p-5 border-amber-200 bg-amber-50/40">
          <h2 className="text-sm font-semibold text-ink-900">
            Extraction engine not connected yet
          </h2>
          <p className="text-xs text-ink-700 mt-1 leading-relaxed">
            The contract, mapping types, and review pipeline are in place, but
            the extraction engine that turns a screenshot or pasted text into
            structured fields runs through Claude Code / Codex / Claude Opus
            and is not yet wired in this build. Use the manual forms below for
            now.
          </p>
        </section>

        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">
            How the import assistant works
          </h2>
          <ol className="mt-3 list-decimal list-inside text-sm text-ink-700 space-y-1">
            <li>Paste a product description, screenshot, or landing-page text.</li>
            <li>Claude / Codex / MCP maps it into structured fields with confidence scores.</li>
            <li>Signal shows the mapping. You confirm, edit, or reject.</li>
            <li>Confirmed fields land in the product or account row.</li>
            <li>Pending records stay <code className="font-mono text-xs">pending_review</code> and cannot be used in plans until you approve.</li>
          </ol>
        </section>

        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">Product import</h2>
          <p className="text-xs text-ink-600 mt-1 leading-relaxed">
            The import UI surface for products is being built. The
            extraction contract is already defined; see{" "}
            <code className="font-mono text-xs">
              src/core/mcp-operations/screenshot-import-contracts.ts
            </code>
            .
          </p>
          <div className="mt-4 rounded-md border border-dashed border-ink-200 p-4 text-xs text-ink-500 leading-relaxed">
            <div className="font-medium text-ink-700 mb-1">
              Coming in this surface:
            </div>
            <ul className="list-disc list-inside space-y-0.5">
              <li>Paste / upload source.</li>
              <li>Extracted-fields preview with per-field confidence.</li>
              <li>Confirm-before-save controls.</li>
            </ul>
          </div>
          <Link
            href="/products"
            className="btn mt-4 inline-flex"
          >
            Use the manual form
          </Link>
        </section>

        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">Account import</h2>
          <p className="text-xs text-ink-600 mt-1 leading-relaxed">
            Account imports work the same way, but never touch the
            platform&apos;s login flow. The screenshot is processed
            in-memory and never saved.
          </p>
          <Link href="/accounts" className="btn mt-4 inline-flex">
            Use the manual form
          </Link>
        </section>

        <section className="card p-5 border-amber-200 bg-amber-50/40">
          <h2 className="text-sm font-semibold text-ink-900">
            Never extracted
          </h2>
          <p className="text-xs text-ink-700 mt-1 leading-relaxed">
            The extractor refuses these fields by contract. They are
            listed in code at{" "}
            <code className="font-mono text-xs">
              NEVER_EXTRACT_FIELDS
            </code>
            :
          </p>
          <ul className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs text-ink-700 font-mono">
            {NEVER_EXTRACT_FIELDS.map((field) => (
              <li key={field}>· {field}</li>
            ))}
          </ul>
        </section>

        <section className="text-[11px] text-ink-500 leading-relaxed">
          Screenshots are never stored permanently by default. Read the
          full policy at{" "}
          <Link href="/settings/mcp" className="text-signal-700 underline">
            /settings/mcp
          </Link>{" "}
          and in <code className="font-mono">docs/mcp/</code>.
        </section>
      </div>
    </>
  );
}
