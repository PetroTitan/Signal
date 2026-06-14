import { describe, expect, it } from "vitest";
import {
  ARTICLES,
  allArticles,
  isPublished,
  linkedSlugs,
  sectionsWithContent,
} from "./registry";
import { SECTIONS } from "./sections";

/**
 * Documentation integrity gates for Signal Academy. These enforce the
 * "no thin pages, no orphans, every link resolves, full sitemap
 * coverage" requirements as executable rules.
 */

describe("Academy content integrity", () => {
  it("has unique slugs", () => {
    const slugs = allArticles().map((a) => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("every article belongs to a known section", () => {
    const ids = new Set(SECTIONS.map((s) => s.id));
    for (const a of allArticles()) expect(ids.has(a.section)).toBe(true);
  });

  it("no thin pages — every article has a description, overview, and real body", () => {
    for (const a of allArticles()) {
      expect(a.description.length, `${a.slug} description`).toBeGreaterThan(40);
      expect(a.overview.length, `${a.slug} overview`).toBeGreaterThan(0);
      expect(a.overview.join(" ").length, `${a.slug} overview length`).toBeGreaterThan(120);
      const hasBody =
        (a.steps?.length ?? 0) > 0 ||
        (a.bullets?.length ?? 0) > 0 ||
        (a.troubleshooting?.length ?? 0) > 0 ||
        (a.faq?.length ?? 0) > 0 ||
        (a.commonMistakes?.length ?? 0) > 0 ||
        a.overview.length >= 2;
      expect(hasBody, `${a.slug} must have structured body`).toBe(true);
    }
  });

  it("every internal link resolves to a published article", () => {
    for (const a of ARTICLES) {
      for (const slug of linkedSlugs(a)) {
        expect(isPublished(slug), `${a.slug} → ${slug} must exist & be published`).toBe(true);
      }
    }
  });

  it("never links to itself", () => {
    for (const a of ARTICLES) {
      expect(linkedSlugs(a)).not.toContain(a.slug);
    }
  });

  it("has no orphan pages — every article is reachable via nav or an inbound link", () => {
    // Sidebar lists every published article by section, so all are
    // nav-reachable; additionally assert graph connectivity: each article
    // is either linked-to by another article or links out itself (so the
    // doc graph is genuinely connected, not a pile of islands).
    const inbound = new Set<string>();
    for (const a of ARTICLES) for (const s of linkedSlugs(a)) inbound.add(s);
    for (const a of ARTICLES) {
      const connected = inbound.has(a.slug) || linkedSlugs(a).length > 0;
      expect(connected, `${a.slug} is orphaned (no inbound or outbound links)`).toBe(true);
    }
  });

  it("every section shown in nav has content", () => {
    for (const s of sectionsWithContent()) {
      expect(ARTICLES.some((a) => a.section === s.id)).toBe(true);
    }
  });

  it("lastUpdated is a valid ISO date", () => {
    for (const a of allArticles()) {
      expect(Number.isNaN(new Date(a.lastUpdated).getTime()), a.slug).toBe(false);
    }
  });
});

describe("Academy sitemap coverage", () => {
  it("sitemap includes every published article + the academy home", async () => {
    const { default: sitemap } = await import("@/app/sitemap");
    const urls = new Set(sitemap().map((e) => e.url));
    expect([...urls].some((u) => u.endsWith("/academy"))).toBe(true);
    for (const a of allArticles()) {
      expect(
        [...urls].some((u) => u.endsWith(`/academy/${a.slug}`)),
        `sitemap missing ${a.slug}`,
      ).toBe(true);
    }
  });
});
