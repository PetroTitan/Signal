import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Philosophy",
  description:
    "Signal's philosophy: sustainable organic presence over posting volume. Weekly approval. Comments-first. OAuth-first.",
  alternates: { canonical: "/philosophy" },
  openGraph: {
    title: "Signal philosophy",
    description:
      "Why Signal optimizes for sustainable presence instead of posting volume — and the operational decisions that follow.",
    type: "article",
  },
};

export default function PhilosophyPage() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-12">
      <h1 className="text-3xl font-semibold text-ink-900 leading-tight">
        Philosophy
      </h1>
      <p className="text-base text-ink-700 mt-3 leading-relaxed">
        Signal optimizes for one outcome: sustainable organic presence. Every
        other product decision falls out of that.
      </p>

      <Section
        title="Sustainable presence beats posting volume"
        body="Volume produces churn. The accounts that compound are the ones that show up consistently with substance. Signal's weekly cadence is built around that rhythm — slow enough to stay credible, regular enough to compound."
      />

      <Section
        title="Comments are first-class presence"
        body="On Reddit, X, and LinkedIn, the best growth move is often non-participation. The second best is a calm, contextual comment. Signal's comment intelligence will recommend 'skip' more often than 'participate' — that is the point."
      />

      <Section
        title="Approve once a week"
        body="Daily notifications break founders. Signal compresses every decision into a single weekly review — approve, soften, delay, save to backlog, reject. After one calm pass, the week is done."
      />

      <Section
        title="Discoverability is not posting"
        body="Search is its own surface. Signal models Google as a discoverability layer — content freshness, topical coverage, evergreen distribution — not as a publishing platform. The split keeps the operating loop honest."
      />

      <Section
        title="OAuth-first, always"
        body="Signal never asks for platform passwords, cookies, session tokens, 2FA codes, or recovery codes. Account onboarding is manual; account connection will happen through official OAuth when integration is enabled. No anti-detect browsers, no proxies, no fingerprint randomization."
      />

      <Section
        title="Risk surfaces calmly"
        body="The risk engine flags before it blocks. Recommendations are concrete (recommended cooldown, soften the CTA, move to backlog). The founder remains the decision-maker."
      />

      <Section
        title="No fake analytics"
        body="When the data isn't connected, Signal says so. We do not invent metrics, fabricate engagement, or fill placeholders with synthetic numbers. WebmasterID integration is the path to real numbers."
      />

      <div className="mt-10 flex flex-wrap gap-2 text-sm">
        <Link href="/how-it-works" className="btn">
          How it works
        </Link>
        <Link href="/security" className="btn">
          Security
        </Link>
        <Link href="/about" className="btn">
          About
        </Link>
      </div>
    </div>
  );
}

function Section({ title, body }: { title: string; body: string }) {
  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold text-ink-900">{title}</h2>
      <p className="text-sm text-ink-700 mt-2 leading-relaxed">{body}</p>
    </section>
  );
}
