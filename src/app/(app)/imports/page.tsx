import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { NEVER_EXTRACT_FIELDS } from "@/core/mcp-operations";
import { PrepareImportForm } from "./_prepare-form";

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

        <section className="card p-5 space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-ink-900">Product import</h2>
            <p className="text-xs text-ink-600 mt-1 leading-relaxed">
              Paste a product description or landing-page copy. Signal records
              the request as a <code className="font-mono text-[11px]">product_profile_suggest</code>{" "}
              operation in <code className="font-mono text-[11px]">pending_approval</code>.
              The extraction runs in the operator&apos;s connected assistant;
              fields land as <code className="font-mono text-[11px]">pending_review</code>{" "}
              and require confirmation before they reach plans.
            </p>
          </div>
          <PrepareImportForm
            kind="product"
            label="Product description / landing-page copy"
            placeholder="Paste the product overview, what it does, who it's for, primary CTA…"
          />
          <Link href="/products" className="text-[11px] text-signal-700 hover:underline">
            Or use the manual product form →
          </Link>
        </section>

        <section className="card p-5 space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-ink-900">Account import</h2>
            <p className="text-xs text-ink-600 mt-1 leading-relaxed">
              Paste an account&apos;s public bio + display name. Signal never
              asks for passwords, cookies, or session tokens — the assistant
              maps the visible profile fields and a human confirms before any
              record is saved.
            </p>
          </div>
          <PrepareImportForm
            kind="account"
            label="Account bio / public profile text"
            placeholder="Paste the platform + display name + bio + visible profile metadata…"
          />
          <Link href="/accounts" className="text-[11px] text-signal-700 hover:underline">
            Or use the manual account form →
          </Link>
        </section>

        <section className="card p-5 border-dashed border-ink-200 bg-ink-50/40">
          <h2 className="text-sm font-semibold text-ink-900">
            Screenshot upload
          </h2>
          <p className="text-xs text-ink-600 mt-1 leading-relaxed">
            Screenshot upload is intentionally not enabled in this phase.
            Phase E3 OAuth and Phase E4 extraction will land it together with
            no-raw-storage defaults. For now, paste the visible text above.
          </p>
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
