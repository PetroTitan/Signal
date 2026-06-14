import type { MetadataRoute } from "next";
import { allArticles } from "@/content/academy/registry";
import { SITE_URL } from "@/content/academy/seo";

/**
 * Sitemap covering public marketing pages + every published Academy
 * article. Generated from the content registry, so new published
 * articles appear automatically and the link-graph test can assert
 * full coverage.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const staticPages = [
    "",
    "/about",
    "/philosophy",
    "/how-it-works",
    "/security",
    "/academy",
  ].map((path) => ({
    url: `${SITE_URL}${path}`,
    changeFrequency: "monthly" as const,
    priority: path === "" ? 1 : 0.7,
  }));

  const articlePages = allArticles().map((a) => ({
    url: `${SITE_URL}/academy/${a.slug}`,
    lastModified: a.lastUpdated,
    changeFrequency: "monthly" as const,
    priority: 0.6,
  }));

  return [...staticPages, ...articlePages];
}
