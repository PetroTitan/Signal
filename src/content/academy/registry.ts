import type { Article, Section, SectionId } from "./types";
import { SECTIONS } from "./sections";
import { gettingStarted } from "./articles/getting-started";
import { weeklyPlans } from "./articles/weekly-plans";
import { publishing } from "./articles/publishing";
import { platforms } from "./articles/platforms";
import { creative } from "./articles/creative";
import { results } from "./articles/results";
import { workspace } from "./articles/workspace";
import { support } from "./articles/support";
import { trust } from "./articles/trust";
import { useCases } from "./articles/use-cases";

/** Every article object across all sections (published + planned). */
const ALL_ARTICLES: Article[] = [
  ...gettingStarted,
  ...weeklyPlans,
  ...publishing,
  ...platforms,
  ...creative,
  ...results,
  ...workspace,
  ...support,
  ...trust,
  ...useCases,
];

/** Only rendered/linked/indexed content. */
export const ARTICLES: Article[] = ALL_ARTICLES.filter((a) => a.published);

const BY_SLUG = new Map<string, Article>(ARTICLES.map((a) => [a.slug, a]));

export { SECTIONS };

export function getArticle(slug: string): Article | undefined {
  return BY_SLUG.get(slug);
}

export function isPublished(slug: string): boolean {
  return BY_SLUG.has(slug);
}

export function allArticles(): Article[] {
  return ARTICLES;
}

export function getSection(id: SectionId): Section | undefined {
  return SECTIONS.find((s) => s.id === id);
}

export function articlesInSection(id: SectionId): Article[] {
  return ARTICLES.filter((a) => a.section === id);
}

/** Sections that have at least one published article, in display order. */
export function sectionsWithContent(): Section[] {
  return [...SECTIONS]
    .filter((s) => articlesInSection(s.id).length > 0)
    .sort((a, b) => a.order - b.order);
}

export interface Crumb {
  label: string;
  href: string;
}

export function breadcrumbsFor(article: Article): Crumb[] {
  const section = getSection(article.section);
  const crumbs: Crumb[] = [{ label: "Academy", href: "/academy" }];
  if (section) {
    crumbs.push({ label: section.title, href: `/academy#${section.id}` });
  }
  crumbs.push({ label: article.title, href: `/academy/${article.slug}` });
  return crumbs;
}

/** Resolve a list of slugs to published articles (silently drops misses;
 *  the link-graph test asserts there are none). */
export function resolveSlugs(slugs: string[] | undefined): Article[] {
  if (!slugs) return [];
  return slugs.map((s) => BY_SLUG.get(s)).filter((a): a is Article => Boolean(a));
}

/** All internal slugs an article links to (prereq + next + related). */
export function linkedSlugs(article: Article): string[] {
  return [
    ...(article.prerequisites ?? []),
    ...(article.nextSteps ?? []),
    ...(article.related ?? []),
  ];
}

export function articleUrl(slug: string): string {
  return `/academy/${slug}`;
}

// =====================================================================
// Planned (not yet written) — tracked as documentation gaps. These are
// NEVER rendered or linked, so they can't orphan or thin the site. They
// exist so the completion report + roadmap stay honest.
// =====================================================================

export const PLANNED: Partial<Record<SectionId, string[]>> = {
  "weekly-plans": ["Draft workflow explained", "Carry over posts between weeks", "Managing content pipelines"],
  bluesky: ["Bluesky media requirements"],
  reddit: ["Reddit approval process"],
  x: ["X publishing workflow (standalone)", "X media requirements (standalone)", "X API limitations"],
  devto: ["dev.to publishing requirements"],
  hashnode: ["Hashnode publishing workflow (standalone)"],
  troubleshooting: [
    "X authentication problems",
    "Reddit publishing problems",
    "Hashnode publishing problems",
  ],
  "use-cases": [
    "Signal for SEO professionals",
    "Signal for open source projects",
    "Signal for personal brands",
    "Signal for startup teams",
    "Signal for product launches",
  ],
  mcp: ["Connect Signal to Claude Code", "Connect Signal to Claude Desktop", "MCP tool reference"],
};
