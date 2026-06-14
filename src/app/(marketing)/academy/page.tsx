import type { Metadata } from "next";
import Link from "next/link";
import { sectionsWithContent, articlesInSection } from "@/content/academy/registry";
import { SECTION_GROUPS } from "@/content/academy/sections";
import { SITE_URL } from "@/content/academy/seo";

export const metadata: Metadata = {
  title: "Signal Academy",
  description:
    "Documentation, guides, and help for Signal — weekly planning, reliable publishing, verified metrics, teams, and MCP. Honest, operator-first docs.",
  alternates: { canonical: "/academy" },
  openGraph: {
    title: "Signal Academy",
    description: "Guides and help for Signal: planning, publishing, metrics, teams, and MCP.",
    type: "website",
    url: "/academy",
  },
};

export default function AcademyHomePage() {
  const sections = sectionsWithContent();
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "Signal Academy",
    url: `${SITE_URL}/academy`,
    description:
      "Documentation and product education for Signal — operator-first growth operations.",
  };

  return (
    <div className="max-w-3xl">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <h1 className="text-3xl font-semibold text-ink-900 tracking-tight">Signal Academy</h1>
      <p className="mt-3 text-base text-ink-700 leading-relaxed">
        Everything you need to run Signal well: how the weekly plan and approval
        gate work, how publishing stays reliable, which metrics are verified per
        platform, and how teams and the MCP bridge fit together. Every page
        reflects how the product actually behaves — no invented features, no
        estimated analytics.
      </p>
      <div className="mt-6 flex flex-wrap gap-2 text-sm">
        <Link href="/academy/what-is-signal" className="btn-primary">
          Start here: What is Signal
        </Link>
        <Link href="/academy/getting-started" className="btn">
          Getting started
        </Link>
      </div>

      {SECTION_GROUPS.map((group) => {
        const groupSections = sections.filter((s) => s.group === group);
        if (groupSections.length === 0) return null;
        return (
          <section key={group} className="mt-10">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">
              {group}
            </h2>
            <div className="mt-3 grid sm:grid-cols-2 gap-3">
              {groupSections.map((s) => {
                const articles = articlesInSection(s.id);
                const first = articles[0];
                return (
                  <Link
                    key={s.id}
                    href={`/academy/${first.slug}`}
                    className="card p-4 hover:border-ink-300 transition-colors"
                    id={s.id}
                  >
                    <div className="text-sm font-semibold text-ink-900">{s.title}</div>
                    <p className="mt-1 text-xs text-ink-600 leading-relaxed">{s.blurb}</p>
                    <div className="mt-2 text-[11px] text-ink-400">
                      {articles.length} article{articles.length === 1 ? "" : "s"}
                    </div>
                  </Link>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
