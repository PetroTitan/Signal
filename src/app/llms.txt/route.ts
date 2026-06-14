import {
  sectionsWithContent,
  articlesInSection,
} from "@/content/academy/registry";
import { SITE_URL } from "@/content/academy/seo";

/**
 * Phase S5 — /llms.txt. An index of Signal Academy for AI assistants,
 * following the llms.txt convention: a title, a one-line summary, then
 * sections of labelled links with descriptions. Generated from the
 * content registry so it always matches what's published.
 */

export const dynamic = "force-static";

export function GET(): Response {
  const lines: string[] = [];
  lines.push("# Signal Academy");
  lines.push("");
  lines.push(
    "> Signal is an operator-first growth operations platform: plan a week of posts, approve them in a single human gate, and publish reliably to connected platforms. Metrics are verified from official provider APIs only — never estimated. The docs below reflect actual product behavior.",
  );
  lines.push("");
  lines.push(
    "Key principles: nothing publishes without human approval; no fabricated analytics; no scraping; verified metrics only (with honest Unavailable/Unsupported states).",
  );
  lines.push("");

  for (const section of sectionsWithContent()) {
    lines.push(`## ${section.title}`);
    for (const a of articlesInSection(section.id)) {
      lines.push(`- [${a.title}](${SITE_URL}/academy/${a.slug}): ${a.description}`);
    }
    lines.push("");
  }

  return new Response(lines.join("\n"), {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
