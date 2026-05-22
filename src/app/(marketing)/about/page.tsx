import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "About",
  description:
    "Signal is an AI-assisted growth operations platform for founders and SaaS teams — built around sustainable presence, not posting volume.",
  alternates: { canonical: "/about" },
  openGraph: {
    title: "About Signal",
    description:
      "Founder growth infrastructure. Calm, operational, OAuth-first. Built around weekly approval and platform-native participation.",
    type: "article",
  },
};

export default function AboutPage() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-12">
      <h1 className="text-3xl font-semibold text-ink-900 leading-tight">
        About Signal
      </h1>
      <p className="text-base text-ink-700 mt-3 leading-relaxed">
        Signal is an AI-assisted growth operations platform for founders and
        SaaS teams. It treats organic presence as an operational problem — one
        that benefits from calm cadence, clean approval, and platform-native
        participation, not from posting volume.
      </p>

      <section className="mt-10 space-y-3">
        <h2 className="text-xl font-semibold text-ink-900">What Signal is</h2>
        <ul className="text-sm text-ink-700 space-y-1 leading-relaxed">
          <li>· Weekly growth planning.</li>
          <li>· One calm approval pass per week.</li>
          <li>· Staggered scheduling that respects platform cadence and account cooldown.</li>
          <li>· A deterministic risk engine that flags before it blocks.</li>
          <li>· Content intelligence built around insights, not prompts.</li>
          <li>· Comment intelligence that knows when to skip a thread.</li>
          <li>· Search &amp; discoverability operations separate from social posting.</li>
        </ul>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-xl font-semibold text-ink-900">What Signal is not</h2>
        <ul className="text-sm text-ink-700 space-y-1 leading-relaxed">
          <li>· Not a spam bot.</li>
          <li>· Not an anti-detect browser.</li>
          <li>· Not an account farm manager.</li>
          <li>· Not a proxy or fingerprint system.</li>
          <li>· Not a mass automation tool.</li>
          <li>· Not a password manager.</li>
          <li>· Not an AI content factory.</li>
        </ul>
      </section>

      <section className="mt-10 card-padded">
        <p className="text-sm text-ink-700 leading-relaxed">
          Signal is built for founders running small portfolios that need to
          show up consistently on Reddit, X, and LinkedIn, and stay visible on
          Google — without burning out, breaking platform rules, or paying for
          tools that optimize for the wrong outcome.
        </p>
      </section>

      <div className="mt-10 flex flex-wrap gap-2 text-sm">
        <Link href="/philosophy" className="btn">
          Read the philosophy
        </Link>
        <Link href="/how-it-works" className="btn">
          How it works
        </Link>
        <Link href="/security" className="btn">
          Security
        </Link>
      </div>
    </div>
  );
}
