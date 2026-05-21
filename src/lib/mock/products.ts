import type { ProductProfile } from "@/types";

export const products: ProductProfile[] = [
  {
    id: "prod_webmasterid",
    slug: "webmasterid",
    name: "WebmasterID",
    domain: "webmasterid.com",
    category: "analytics",
    positioning:
      "Identity-aware analytics for AI-driven web traffic. Distinguishes bot, agent, and human visits.",
    targetAudience: [
      "Indie SaaS founders",
      "Growth engineers",
      "Technical product managers",
    ],
    preferredPlatforms: ["x", "linkedin", "reddit"],
    ctaStyle: "contextual_link",
    allowedCtaCopy: [
      "Free tier available at webmasterid.com",
      "Open the dashboard to see your AI referral split",
    ],
    forbiddenClaims: [
      "Detects 100% of bots",
      "Guarantees attribution accuracy",
      "Replaces your analytics stack",
    ],
    riskTolerance: "balanced",
    contentStyle:
      "Operator voice. Concrete numbers. Avoid hype. Lead with a problem the reader recognizes.",
    trackingMetadata: {
      utmSource: "signal",
      utmMediumByPlatform: {
        reddit: "reddit_organic",
        x: "x_organic",
        linkedin: "linkedin_organic",
      },
      campaignPrefix: "wmi",
    },
  },
  {
    id: "prod_cash_workspace",
    slug: "cash-workspace",
    name: "Cash Workspace",
    domain: "cashworkspace.com",
    category: "finance",
    positioning:
      "Lightweight cash-flow workspace for solo operators and small studios.",
    targetAudience: ["Solo founders", "Freelancers", "Small agency owners"],
    preferredPlatforms: ["x", "linkedin"],
    ctaStyle: "soft_mention",
    allowedCtaCopy: [
      "I built this for myself: cashworkspace.com",
      "Free for personal use",
    ],
    forbiddenClaims: [
      "Replaces your accountant",
      "Tax filing included",
      "Bank-grade security",
    ],
    riskTolerance: "conservative",
    contentStyle: "Calm, practical, founder-journal tone. Numbers and screenshots over claims.",
    trackingMetadata: {
      utmSource: "signal",
      utmMediumByPlatform: {
        reddit: "reddit_organic",
        x: "x_organic",
        linkedin: "linkedin_organic",
      },
      campaignPrefix: "cw",
    },
  },
  {
    id: "prod_twinphone",
    slug: "twinphone",
    name: "TwinPhone",
    domain: "twinphone.app",
    category: "communication",
    positioning:
      "Second-line phone for founders. Keeps business calls separate from personal.",
    targetAudience: ["Founders", "Operators with customer-facing roles"],
    preferredPlatforms: ["x", "reddit"],
    ctaStyle: "soft_mention",
    allowedCtaCopy: ["More at twinphone.app", "Available on iOS and Android"],
    forbiddenClaims: [
      "End-to-end encrypted across all carriers",
      "Anonymous calling",
      "Untraceable",
    ],
    riskTolerance: "conservative",
    contentStyle: "Practical, story-driven. Show real founder use cases.",
    trackingMetadata: {
      utmSource: "signal",
      utmMediumByPlatform: {
        reddit: "reddit_organic",
        x: "x_organic",
        linkedin: "linkedin_organic",
      },
      campaignPrefix: "tp",
    },
  },
  {
    id: "prod_pdf_tools",
    slug: "pdf-tools",
    name: "PDF tools",
    domain: "pdftools.studio",
    category: "utility",
    positioning:
      "Focused PDF utilities. Each tool does one job well, in the browser, with no upload.",
    targetAudience: ["Office workers", "Students", "Small business owners"],
    preferredPlatforms: ["reddit", "x"],
    ctaStyle: "contextual_link",
    allowedCtaCopy: ["Free at pdftools.studio", "Runs locally in your browser"],
    forbiddenClaims: ["100% accurate OCR", "Best PDF tool online"],
    riskTolerance: "balanced",
    contentStyle: "Helpful, utility-first. Link only when directly relevant.",
    trackingMetadata: {
      utmSource: "signal",
      utmMediumByPlatform: {
        reddit: "reddit_organic",
        x: "x_organic",
        linkedin: "linkedin_organic",
      },
      campaignPrefix: "pdf",
    },
  },
  {
    id: "prod_printer_apps",
    slug: "printer-apps",
    name: "Printer apps",
    domain: "printerapps.io",
    category: "utility",
    positioning:
      "Print-from-anywhere utilities. AirPrint helpers and label-printer companions.",
    targetAudience: ["Home office users", "Small retail", "Etsy sellers"],
    preferredPlatforms: ["reddit"],
    ctaStyle: "soft_mention",
    allowedCtaCopy: ["Available at printerapps.io"],
    forbiddenClaims: ["Works with every printer ever made"],
    riskTolerance: "conservative",
    contentStyle: "Problem-then-fix. Stick to specific printer models or use-cases.",
    trackingMetadata: {
      utmSource: "signal",
      utmMediumByPlatform: {
        reddit: "reddit_organic",
        x: "x_organic",
        linkedin: "linkedin_organic",
      },
      campaignPrefix: "pra",
    },
  },
  {
    id: "prod_helperg",
    slug: "helperg",
    name: "HELPERG",
    domain: "helperg.com",
    category: "consulting",
    positioning:
      "Growth operations studio. Behind the products in this workspace.",
    targetAudience: ["Founders evaluating fractional growth", "Indie operators"],
    preferredPlatforms: ["linkedin", "x"],
    ctaStyle: "no_cta",
    allowedCtaCopy: [],
    forbiddenClaims: ["Guaranteed growth", "Hockey-stick results"],
    riskTolerance: "conservative",
    contentStyle:
      "Founder voice. Long-form lessons and operator notes. No selling.",
    trackingMetadata: {
      utmSource: "signal",
      utmMediumByPlatform: {
        reddit: "reddit_organic",
        x: "x_organic",
        linkedin: "linkedin_organic",
      },
      campaignPrefix: "hg",
    },
  },
];

export const productsById = Object.fromEntries(
  products.map((p) => [p.id, p]),
) as Record<string, ProductProfile>;

export const productsBySlug = Object.fromEntries(
  products.map((p) => [p.slug, p]),
) as Record<string, ProductProfile>;
