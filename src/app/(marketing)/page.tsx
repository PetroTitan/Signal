import type { Metadata } from "next";
import Link from "next/link";
import { SITE_URL } from "@/content/academy/seo";

export const metadata: Metadata = {
  title: "Signal — Operator-controlled publishing infrastructure",
  description:
    "Signal is operator-controlled publishing infrastructure for teams that need approval, scheduling, reliability, and verified results. Nothing publishes without human approval.",
  alternates: { canonical: "/" },
  openGraph: {
    title: "Signal — Operator-controlled publishing infrastructure",
    description:
      "Plan, approve, schedule, publish, and measure — with an approval gate, publishing reliability, and verified-only metrics.",
    type: "website",
    url: "/",
    siteName: "Signal",
  },
  twitter: {
    card: "summary_large_image",
    title: "Signal — Operator-controlled publishing infrastructure",
    description:
      "Approval-first publishing for teams. No autonomous posting. Verified metrics only.",
  },
};

const WHAT_SIGNAL_DOES = [
  ["Plan content", "Organize a week of posts across platforms in one place."],
  ["Approve drafts", "Review everything in a single human gate before it schedules."],
  ["Schedule posts", "Approved items wait for their time; the scheduler does the rest."],
  ["Publish through connected platforms", "Bluesky, Reddit, X, LinkedIn, dev.to, Hashnode, Telegram."],
  ["Track results", "Verified engagement read from official provider APIs — never estimated."],
  ["Manage teams", "Roles, a reviewer approval gate, ownership transfer, and an audit trail."],
];

const WHY_DIFFERENT = [
  ["Approval-first", "Every item is a recommendation until a person approves it."],
  ["No autonomous publishing", "There is no path that posts on your behalf without approval."],
  ["Audit trail", "Who approved what, and what actually published, is recorded."],
  ["Platform-aware media", "Images are transcoded into a provider-safe derivative before publishing."],
  ["Reliability built in", "Atomic claims prevent double-posts; transient errors retry with backoff."],
  ["Verified metrics only", "If a platform can't expose a metric, Signal shows \"Unavailable\" — never a guess."],
];

const WORKFLOWS = [
  ["Plan", "Draft a week of items, each with a platform and a time."],
  ["Approve", "One calm review pass — the single gate between idea and live post."],
  ["Publish", "The scheduler claims, publishes, and records each item reliably."],
  ["Measure", "Results shows real permalinks, timings, and verified engagement."],
  ["Reuse", "Carry insight from results back into the next week's plan."],
];

interface PlatformRow {
  name: string;
  publishing: string;
  metrics: string;
  tone: "ok" | "partial" | "none";
}
const PLATFORMS: PlatformRow[] = [
  { name: "Bluesky", publishing: "Automated", metrics: "Verified (likes, reposts, replies, quotes)", tone: "ok" },
  { name: "dev.to", publishing: "Automated", metrics: "Verified (reactions, comments)", tone: "ok" },
  { name: "Reddit", publishing: "Automated (subreddit rules apply)", metrics: "Verified (score, comments)", tone: "ok" },
  { name: "X", publishing: "Automated", metrics: "Unavailable (requires a paid API tier)", tone: "partial" },
  { name: "Hashnode", publishing: "Automated", metrics: "Unavailable (not yet integrated)", tone: "partial" },
  { name: "LinkedIn", publishing: "Automated", metrics: "Unavailable (requires approved Marketing API)", tone: "partial" },
  { name: "Telegram", publishing: "Automated", metrics: "No post metrics exposed by the API", tone: "partial" },
  { name: "Threads, Instagram, YouTube", publishing: "Not yet automated", metrics: "—", tone: "none" },
];

const TONE_DOT: Record<PlatformRow["tone"], string> = {
  ok: "bg-emerald-500",
  partial: "bg-amber-400",
  none: "bg-ink-300",
};

export default function HomePage() {
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        name: "Signal",
        url: SITE_URL,
        description:
          "Operator-controlled publishing infrastructure for teams that need approval, scheduling, reliability, and verified results.",
      },
      {
        "@type": "SoftwareApplication",
        name: "Signal",
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web",
        url: SITE_URL,
        description:
          "Approval-first publishing: plan, approve, schedule, publish, and measure across connected platforms with verified-only metrics.",
      },
    ],
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      {/* Hero */}
      <section className="border-b border-ink-100 bg-white">
        <div className="max-w-5xl mx-auto px-6 py-16 sm:py-24">
          <span className="inline-block badge-info text-[11px]">Approval-first publishing</span>
          <h1 className="mt-4 text-4xl sm:text-5xl font-semibold tracking-tight text-ink-900 leading-[1.1] max-w-3xl">
            Operator-controlled publishing infrastructure
          </h1>
          <p className="mt-4 text-lg text-ink-600 leading-relaxed max-w-2xl">
            Signal is publishing infrastructure for teams that need approval,
            scheduling, reliability, and results. You plan a week, approve it in
            one pass, and Signal publishes to your connected platforms — nothing
            goes out without a human approving it.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link href="/signup" className="btn-primary">
              Sign up
            </Link>
            <Link href="/login" className="btn">
              Sign in
            </Link>
            <Link href="/academy" className="btn-ghost text-signal-700">
              Explore Academy →
            </Link>
          </div>
        </div>
      </section>

      <div className="max-w-5xl mx-auto px-6 py-14 space-y-16">
        {/* What Signal does */}
        <section>
          <h2 className="text-2xl font-semibold text-ink-900 tracking-tight">What Signal does</h2>
          <div className="mt-6 grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {WHAT_SIGNAL_DOES.map(([title, body]) => (
              <div key={title} className="card p-5">
                <div className="text-sm font-semibold text-ink-900">{title}</div>
                <p className="mt-1 text-sm text-ink-600 leading-relaxed">{body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Why Signal is different */}
        <section>
          <h2 className="text-2xl font-semibold text-ink-900 tracking-tight">Why Signal is different</h2>
          <p className="mt-2 text-sm text-ink-600 max-w-2xl leading-relaxed">
            Signal is deliberately not an autopilot. It&apos;s built so a human
            stays in control and the data stays honest.
          </p>
          <div className="mt-6 grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {WHY_DIFFERENT.map(([title, body]) => (
              <div key={title} className="card p-5">
                <div className="text-sm font-semibold text-ink-900">{title}</div>
                <p className="mt-1 text-sm text-ink-600 leading-relaxed">{body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Core workflows */}
        <section>
          <h2 className="text-2xl font-semibold text-ink-900 tracking-tight">Core workflows</h2>
          <ol className="mt-6 grid sm:grid-cols-5 gap-3">
            {WORKFLOWS.map(([title, body], i) => (
              <li key={title} className="card p-4">
                <div className="h-7 w-7 rounded-full bg-ink-100 text-ink-700 text-xs font-semibold inline-flex items-center justify-center">
                  {i + 1}
                </div>
                <div className="mt-2 text-sm font-semibold text-ink-900">{title}</div>
                <p className="mt-1 text-xs text-ink-600 leading-relaxed">{body}</p>
              </li>
            ))}
          </ol>
          <div className="mt-4 text-sm">
            <Link href="/academy/understanding-the-workflow" className="text-signal-700 hover:text-signal-800">
              See the full workflow in the Academy →
            </Link>
          </div>
        </section>

        {/* Platform status */}
        <section>
          <h2 className="text-2xl font-semibold text-ink-900 tracking-tight">Platform status</h2>
          <p className="mt-2 text-sm text-ink-600 max-w-2xl leading-relaxed">
            An honest view of what&apos;s supported today. Where a platform
            can&apos;t expose a metric, we say so rather than estimating it.
          </p>
          <div className="mt-6 card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-100 text-left text-[11px] uppercase tracking-wider text-ink-400">
                  <th className="px-4 py-2 font-semibold">Platform</th>
                  <th className="px-4 py-2 font-semibold">Publishing</th>
                  <th className="px-4 py-2 font-semibold">Metrics</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {PLATFORMS.map((p) => (
                  <tr key={p.name}>
                    <td className="px-4 py-2.5">
                      <span className="inline-flex items-center gap-2">
                        <span className={`h-1.5 w-1.5 rounded-full ${TONE_DOT[p.tone]}`} aria-hidden />
                        <span className="text-ink-900 font-medium">{p.name}</span>
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-ink-700">{p.publishing}</td>
                    <td className="px-4 py-2.5 text-ink-600">{p.metrics}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 text-sm">
            <Link href="/academy/supported-metrics-by-platform" className="text-signal-700 hover:text-signal-800">
              Supported metrics by platform →
            </Link>
          </div>
        </section>

        {/* Academy + Trust CTAs */}
        <section className="grid sm:grid-cols-2 gap-4">
          <div className="card p-6">
            <h3 className="text-lg font-semibold text-ink-900">Learn how Signal works</h3>
            <p className="mt-1 text-sm text-ink-600 leading-relaxed">
              Signal Academy is the full documentation: getting started, the
              weekly plan, publishing reliability, metrics, teams, and MCP.
            </p>
            <Link href="/academy" className="btn mt-4">
              Explore the Academy
            </Link>
          </div>
          <div className="card p-6">
            <h3 className="text-lg font-semibold text-ink-900">How we keep it safe</h3>
            <p className="mt-1 text-sm text-ink-600 leading-relaxed">
              Read the approval model, security overview, and how Signal prevents
              accidental publishing — all grounded in how the product actually
              behaves.
            </p>
            <div className="mt-4 flex flex-wrap gap-3 text-sm">
              <Link href="/academy/approval-model" className="text-signal-700 hover:text-signal-800">
                Approval model →
              </Link>
              <Link href="/academy/security-overview" className="text-signal-700 hover:text-signal-800">
                Security →
              </Link>
              <Link href="/academy/what-is-mcp" className="text-signal-700 hover:text-signal-800">
                MCP for Claude →
              </Link>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
