import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Security",
  description:
    "Signal is OAuth-first by design. We never ask for platform passwords, cookies, session tokens, 2FA codes, or recovery codes.",
  alternates: { canonical: "/security" },
  openGraph: {
    title: "Signal security",
    description:
      "OAuth-first. No passwords. No anti-detect tooling. No proxy systems. No fingerprint manipulation.",
    type: "article",
  },
};

export default function SecurityPage() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-12">
      <h1 className="text-3xl font-semibold text-ink-900 leading-tight">
        Security
      </h1>
      <p className="text-base text-ink-700 mt-3 leading-relaxed">
        Signal&apos;s security posture is a product decision, not a checklist.
        The principles below are how the system is shaped — not what we promise.
      </p>

      <section className="mt-10 space-y-3">
        <h2 className="text-xl font-semibold text-ink-900">
          What Signal will never ask for
        </h2>
        <ul className="text-sm text-ink-700 space-y-1 leading-relaxed">
          <li>· Platform passwords.</li>
          <li>· Cookies or browser session tokens.</li>
          <li>· 2FA codes or recovery codes.</li>
          <li>· Proxy or fingerprint configuration.</li>
          <li>· Credentials of any kind that aren&apos;t scoped through OAuth.</li>
        </ul>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold text-ink-900">
          OAuth-first account model
        </h2>
        <p className="text-sm text-ink-700 leading-relaxed">
          Every account connects through the platform&apos;s official
          authorization flow. Scopes are requested explicitly, OAuth tokens are
          encrypted at rest and revocable from inside the app, and each
          connection is visible per account. Signal never asks for or stores a
          platform password.
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold text-ink-900">
          What Signal will never do
        </h2>
        <ul className="text-sm text-ink-700 space-y-1 leading-relaxed">
          <li>· Use anti-detect browsers.</li>
          <li>· Route through proxies to disguise origin.</li>
          <li>· Randomize browser fingerprints.</li>
          <li>· Manage farms of synthetic accounts.</li>
          <li>· Publish, comment, or reply without your explicit approval.</li>
          <li>· Auto-index or manipulate content for search rankings.</li>
          <li>· Fabricate analytics. When data isn&apos;t connected, we say so.</li>
        </ul>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold text-ink-900">
          Human approval is structural
        </h2>
        <p className="text-sm text-ink-700 leading-relaxed">
          Every item Signal surfaces is a recommendation. The founder
          approves, softens, delays, or sets aside each item — there is no
          path through the system that bypasses the weekly review. Approved
          items publish on the schedule you set; nothing reaches a platform
          outside that approval.
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold text-ink-900">
          Persistence &amp; encryption
        </h2>
        <p className="text-sm text-ink-700 leading-relaxed">
          Signal stores your workspace data in Postgres behind per-workspace
          row-level security. Sensitive credentials — OAuth access and refresh
          tokens — are encrypted at rest (AES-256-GCM) and never logged, with
          rotation and revocation wired into the account management flow.
        </p>
      </section>

      <div className="mt-10 flex flex-wrap gap-2 text-sm">
        <Link href="/philosophy" className="btn">
          Philosophy
        </Link>
        <Link href="/how-it-works" className="btn">
          How it works
        </Link>
        <Link href="/about" className="btn">
          About
        </Link>
      </div>
    </div>
  );
}
