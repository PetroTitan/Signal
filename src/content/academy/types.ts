/**
 * Signal Academy — content model.
 *
 * Documentation is data, not hand-built JSX. Each article is a typed
 * object with structured fields so the renderer, SEO metadata, JSON-LD,
 * breadcrumbs, internal-link graph, sitemap, and llms.txt all derive
 * from ONE source of truth and stay in sync.
 *
 * Editorial rules (enforced by review, not the type system):
 *   - Every article solves a real user problem.
 *   - Content reflects ACTUAL production behavior. No invented features,
 *     no fabricated limits, no AI filler.
 *   - Only `published: true` articles render, appear in nav, the
 *     sitemap, llms.txt, and the link graph. Planned-but-unwritten
 *     articles are tracked as gaps and never linked (so: no orphans,
 *     no thin pages).
 */

/** A paragraph of plain prose. Rendered as-is (no markdown parser dep). */
export type Paragraph = string;

export interface Step {
  title: string;
  body: Paragraph;
}

export interface Troubleshoot {
  problem: string;
  fix: Paragraph;
}

export interface FaqItem {
  q: string;
  a: Paragraph;
}

/** A bullet list with an optional heading. */
export interface BulletBlock {
  heading?: string;
  items: Paragraph[];
}

export interface Article {
  /** URL slug, unique across the Academy (e.g. "connect-bluesky"). */
  slug: string;
  /** Section id this article belongs to. */
  section: SectionId;
  title: string;
  /** <=160 chars — used for <meta description>, OG, and link previews. */
  description: string;
  /** ISO date (YYYY-MM-DD) of last substantive edit. */
  lastUpdated: string;
  /** Lead paragraphs (the "Overview"). At least one. */
  overview: Paragraph[];
  /** Optional structured body. */
  steps?: Step[];
  bullets?: BulletBlock[];
  commonMistakes?: Paragraph[];
  troubleshooting?: Troubleshoot[];
  faq?: FaqItem[];
  /** Slugs the reader should understand first. */
  prerequisites?: string[];
  /** Slugs to read next (the forward path). */
  nextSteps?: string[];
  /** Slugs of related articles. */
  related?: string[];
  /** External, official references (platform docs etc.). */
  externalRefs?: { label: string; href: string }[];
  /** false (or omitted) → planned but not rendered/linked yet. */
  published: boolean;
}

export type SectionId =
  | "getting-started"
  | "weekly-plans"
  | "publishing"
  | "bluesky"
  | "reddit"
  | "x"
  | "devto"
  | "hashnode"
  | "creative"
  | "results"
  | "teams"
  | "notifications"
  | "mcp"
  | "troubleshooting"
  | "use-cases"
  | "trust";

export interface Section {
  id: SectionId;
  title: string;
  /** Short, used on the Academy home + section headers. */
  blurb: string;
  /** Display order in the sidebar. */
  order: number;
  /** Grouping label for the sidebar ("Platforms", "Guides", …). */
  group: string;
}
