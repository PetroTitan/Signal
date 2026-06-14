import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  allArticles,
  getArticle,
  breadcrumbsFor,
  resolveSlugs,
} from "@/content/academy/registry";
import { getSection } from "@/content/academy/registry";
import { buildArticleMetadata, buildArticleJsonLd } from "@/content/academy/seo";
import type { Article } from "@/content/academy/types";

export const dynamicParams = false;

export function generateStaticParams() {
  return allArticles().map((a) => ({ slug: a.slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const article = getArticle(params.slug);
  if (!article) return {};
  return buildArticleMetadata(article);
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function RelatedList({ title, articles }: { title: string; articles: Article[] }) {
  if (articles.length === 0) return null;
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-400">{title}</h3>
      <ul className="mt-2 space-y-1">
        {articles.map((a) => (
          <li key={a.slug}>
            <Link
              href={`/academy/${a.slug}`}
              className="text-sm text-signal-700 hover:text-signal-800"
            >
              {a.title} →
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function AcademyArticlePage({ params }: { params: { slug: string } }) {
  const article = getArticle(params.slug);
  if (!article) notFound();

  const section = getSection(article.section);
  const crumbs = breadcrumbsFor(article);
  const jsonLd = buildArticleJsonLd(article);
  const prereqs = resolveSlugs(article.prerequisites);
  const nexts = resolveSlugs(article.nextSteps);
  const related = resolveSlugs(article.related);

  return (
    <article className="max-w-2xl">
      {jsonLd.map((node, i) => (
        <script
          key={i}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(node) }}
        />
      ))}

      {/* Breadcrumbs */}
      <nav aria-label="Breadcrumb" className="text-[11px] text-ink-500">
        <ol className="flex flex-wrap items-center gap-1">
          {crumbs.map((c, i) => (
            <li key={c.href} className="flex items-center gap-1">
              {i > 0 ? <span className="text-ink-300">/</span> : null}
              {i < crumbs.length - 1 ? (
                <Link href={c.href} className="hover:text-ink-700">
                  {c.label}
                </Link>
              ) : (
                <span className="text-ink-700">{c.label}</span>
              )}
            </li>
          ))}
        </ol>
      </nav>

      <header className="mt-3">
        {section ? (
          <div className="text-[11px] font-semibold uppercase tracking-wider text-signal-700">
            {section.title}
          </div>
        ) : null}
        <h1 className="mt-1 text-3xl font-semibold text-ink-900 tracking-tight leading-tight">
          {article.title}
        </h1>
        <p className="mt-2 text-base text-ink-700 leading-relaxed">{article.description}</p>
        <p className="mt-2 text-[11px] text-ink-400">Last updated {fmtDate(article.lastUpdated)}</p>
      </header>

      {/* Overview */}
      <section className="mt-8 space-y-3">
        {article.overview.map((p, i) => (
          <p key={i} className="text-sm text-ink-700 leading-relaxed">
            {p}
          </p>
        ))}
      </section>

      {/* Bullets */}
      {article.bullets?.map((block, i) => (
        <section key={i} className="mt-6">
          {block.heading ? (
            <h2 className="text-base font-semibold text-ink-900">{block.heading}</h2>
          ) : null}
          <ul className="mt-2 space-y-1.5">
            {block.items.map((item, j) => (
              <li key={j} className="text-sm text-ink-700 leading-relaxed flex gap-2">
                <span className="text-ink-300 select-none">·</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {/* Steps */}
      {article.steps && article.steps.length > 0 ? (
        <section className="mt-8">
          <h2 className="text-base font-semibold text-ink-900">Step by step</h2>
          <ol className="mt-3 space-y-4">
            {article.steps.map((s, i) => (
              <li key={i} className="flex gap-3">
                <span className="shrink-0 h-6 w-6 rounded-full bg-ink-100 text-ink-700 text-xs font-semibold inline-flex items-center justify-center">
                  {i + 1}
                </span>
                <div>
                  <div className="text-sm font-medium text-ink-900">{s.title}</div>
                  <p className="mt-0.5 text-sm text-ink-700 leading-relaxed">{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {/* Common mistakes */}
      {article.commonMistakes && article.commonMistakes.length > 0 ? (
        <section className="mt-8">
          <h2 className="text-base font-semibold text-ink-900">Common mistakes</h2>
          <ul className="mt-2 space-y-1.5">
            {article.commonMistakes.map((m, i) => (
              <li key={i} className="text-sm text-ink-700 leading-relaxed flex gap-2">
                <span className="text-amber-500 select-none">!</span>
                <span>{m}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Troubleshooting */}
      {article.troubleshooting && article.troubleshooting.length > 0 ? (
        <section className="mt-8">
          <h2 className="text-base font-semibold text-ink-900">Troubleshooting</h2>
          <dl className="mt-2 space-y-3">
            {article.troubleshooting.map((t, i) => (
              <div key={i}>
                <dt className="text-sm font-medium text-ink-900">{t.problem}</dt>
                <dd className="mt-0.5 text-sm text-ink-700 leading-relaxed">{t.fix}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {/* FAQ */}
      {article.faq && article.faq.length > 0 ? (
        <section className="mt-8">
          <h2 className="text-base font-semibold text-ink-900">FAQ</h2>
          <dl className="mt-2 space-y-3">
            {article.faq.map((f, i) => (
              <div key={i}>
                <dt className="text-sm font-medium text-ink-900">{f.q}</dt>
                <dd className="mt-0.5 text-sm text-ink-700 leading-relaxed">{f.a}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {/* External refs */}
      {article.externalRefs && article.externalRefs.length > 0 ? (
        <section className="mt-8">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-400">
            References
          </h3>
          <ul className="mt-2 space-y-1">
            {article.externalRefs.map((r) => (
              <li key={r.href}>
                <a
                  href={r.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-signal-700 hover:text-signal-800"
                >
                  {r.label} ↗
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Graph links */}
      {prereqs.length + nexts.length + related.length > 0 ? (
        <footer className="mt-12 border-t border-ink-100 pt-6 grid sm:grid-cols-3 gap-6">
          <RelatedList title="Prerequisites" articles={prereqs} />
          <RelatedList title="Next steps" articles={nexts} />
          <RelatedList title="Related" articles={related} />
        </footer>
      ) : null}
    </article>
  );
}
