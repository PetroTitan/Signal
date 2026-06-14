import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import HomePage from "./page";
import { GET as llmsGet } from "@/app/llms.txt/route";
import sitemap from "@/app/sitemap";
import { allArticles } from "@/content/academy/registry";
import { SITE_URL } from "@/content/academy/seo";

/**
 * Public visibility: the root marketing homepage renders as marketing
 * (not a redirect/login), links to the right places, and is honest about
 * platform support; the SEO/AI files cover Academy URLs.
 */
describe("public marketing homepage", () => {
  const html = renderToStaticMarkup(createElement(HomePage));

  it("renders the marketing hero, not a login form", () => {
    expect(html).toContain("Operator-controlled publishing infrastructure");
    expect(html).not.toContain('type="password"');
  });

  it("links to sign up, sign in, and the Academy", () => {
    expect(html).toContain('href="/signup"');
    expect(html).toContain('href="/login"');
    expect(html).toContain('href="/academy"');
  });

  it("links to trust + MCP Academy pages", () => {
    expect(html).toContain('href="/academy/approval-model"');
    expect(html).toContain('href="/academy/security-overview"');
    expect(html).toContain('href="/academy/what-is-mcp"');
  });

  it("is honest about platform support (no invented automation)", () => {
    expect(html).toContain("Bluesky");
    expect(html).toContain("Unavailable"); // X / Hashnode / LinkedIn metrics
    expect(html).toContain("Not yet automated"); // Threads / Instagram / YouTube
    // It must not claim verified metrics for X.
    expect(html).not.toMatch(/X[^<]*Verified/);
  });
});

describe("Academy discovery files", () => {
  it("llms.txt includes Academy article URLs", async () => {
    const res = llmsGet();
    const text = await res.text();
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(text).toContain("/academy/what-is-signal");
    expect(text).toContain("# Signal Academy");
    // Spot-check a few more so it's not a one-off.
    expect(text).toContain("/academy/supported-metrics-by-platform");
  });

  it("sitemap includes the homepage, /academy, and every published article", () => {
    const urls = new Set(sitemap().map((e) => e.url));
    expect(urls.has(SITE_URL)).toBe(true); // homepage
    expect([...urls].some((u) => u.endsWith("/academy"))).toBe(true);
    for (const a of allArticles()) {
      expect([...urls].some((u) => u.endsWith(`/academy/${a.slug}`)), a.slug).toBe(true);
    }
  });
});
