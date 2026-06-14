import type { Metadata } from "next";
import type { Article } from "./types";
import { breadcrumbsFor } from "./registry";

/** Matches the root layout's metadataBase. Used for absolute JSON-LD URLs. */
export const SITE_URL = "https://signal.helperg.com";

export function articlePath(slug: string): string {
  return `/academy/${slug}`;
}

export function articleAbsoluteUrl(slug: string): string {
  return `${SITE_URL}${articlePath(slug)}`;
}

/**
 * Per-article Next metadata: canonical, Open Graph, and Twitter. Titles
 * use the root template ("%s · Signal").
 */
export function buildArticleMetadata(article: Article): Metadata {
  const url = articlePath(article.slug);
  return {
    title: article.title,
    description: article.description,
    alternates: { canonical: url },
    openGraph: {
      title: article.title,
      description: article.description,
      type: "article",
      url,
      siteName: "Signal",
      modifiedTime: article.lastUpdated,
    },
    twitter: {
      card: "summary_large_image",
      title: article.title,
      description: article.description,
    },
  };
}

type JsonLd = Record<string, unknown>;

/**
 * JSON-LD graph for an article: a TechArticle, a BreadcrumbList, and a
 * FAQPage when the article has FAQs. AI assistants + search engines read
 * these for structured answers. Every value is real article content.
 */
export function buildArticleJsonLd(article: Article): JsonLd[] {
  const url = articleAbsoluteUrl(article.slug);
  const graph: JsonLd[] = [
    {
      "@context": "https://schema.org",
      "@type": "TechArticle",
      headline: article.title,
      description: article.description,
      url,
      dateModified: article.lastUpdated,
      inLanguage: "en",
      isPartOf: { "@type": "WebSite", name: "Signal Academy", url: `${SITE_URL}/academy` },
      publisher: { "@type": "Organization", name: "Signal", url: SITE_URL },
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: breadcrumbsFor(article).map((c, i) => ({
        "@type": "ListItem",
        position: i + 1,
        name: c.label,
        item: `${SITE_URL}${c.href}`,
      })),
    },
  ];

  if (article.faq && article.faq.length > 0) {
    graph.push({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: article.faq.map((f) => ({
        "@type": "Question",
        name: f.q,
        acceptedAnswer: { "@type": "Answer", text: f.a },
      })),
    });
  }

  return graph;
}
