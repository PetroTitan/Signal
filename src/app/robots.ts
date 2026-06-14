import type { MetadataRoute } from "next";
import { SITE_URL } from "@/content/academy/seo";

/**
 * Phase S5 — crawler policy. The public marketing + Academy surface is
 * meant to be found, including by reputable AI assistants. We explicitly
 * welcome the major AI crawlers and point everyone at the sitemap.
 * Authenticated app routes and the cron/API endpoints are disallowed
 * from indexing (they require a session or a secret anyway).
 */
const AI_AND_SEARCH_AGENTS = [
  "*",
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-Web",
  "anthropic-ai",
  "PerplexityBot",
  "Google-Extended",
  "Googlebot",
  "Bingbot",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: AI_AND_SEARCH_AGENTS.map((userAgent) => ({
      userAgent,
      allow: "/",
      disallow: [
        "/api/",
        "/dashboard",
        "/settings",
        "/execution",
        "/weekly-plan",
        "/library",
        "/results",
        "/notifications",
        "/accounts",
        "/backlog",
        "/products",
        "/weekly-contracts",
        "/activity",
        "/operator-bridge",
        "/invite",
      ],
    })),
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
