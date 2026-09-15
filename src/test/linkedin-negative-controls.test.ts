/**
 * Structural negative controls for the LinkedIn Sales workspace.
 *
 * Each one asserts the ABSENCE of something the compliance boundary
 * forbids: browser automation, LinkedIn credentials, undocumented
 * endpoints, automatic member actions, a widened OAuth scope. They read
 * the repository as it is, so a future change that adds one of these
 * fails here before it ships.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      walk(p, out);
    } else if (/\.(tsx?|sql|json|mjs|cjs)$/.test(entry)) out.push(p);
  }
  return out;
}

const SRC = walk(path.join(ROOT, "src")).filter((f) => !f.endsWith(".test.ts"));
const LINKEDIN_CODE = [
  ...walk(path.join(ROOT, "src/core/linkedin-sales")).filter((f) => !f.endsWith(".test.ts")),
  ...walk(path.join(ROOT, "src/app/(app)/linkedin")).filter((f) => !f.endsWith(".test.ts")),
  ...walk(path.join(ROOT, "src/app/api/linkedin")),
  path.join(ROOT, "src/repositories/linkedin-sales-repository.ts"),
];
const LINKEDIN_MIGRATIONS = readdirSync(path.join(ROOT, "supabase/migrations"))
  .filter((f) => f.includes("linkedin"))
  .map((f) => path.join(ROOT, "supabase/migrations", f));
const rel = (f: string) => path.relative(ROOT, f);

describe("no browser automation", () => {
  const AUTOMATION = ["playwright", "playwright-core", "puppeteer", "puppeteer-core", "selenium-webdriver", "webdriverio", "cheerio", "crawlee", "apify", "nightmare", "phantomjs"];

  it("none of the browser-automation or scraping packages is a dependency", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    for (const name of AUTOMATION) expect(deps, name).not.toContain(name);
    expect(deps.length).toBeGreaterThan(5);
  });

  it("no source file imports one, and nothing under src drives a browser", () => {
    for (const f of SRC) {
      const src = readFileSync(f, "utf8");
      for (const name of AUTOMATION) {
        expect(src, `${rel(f)} imports ${name}`).not.toMatch(new RegExp(`from ["']${name}["']|require\\(["']${name}["']\\)`));
      }
      expect(src, rel(f)).not.toMatch(/chromium\.launch|\.newPage\(|page\.goto\(/);
    }
    expect(SRC.length).toBeGreaterThan(100);
  });
});

describe("no LinkedIn credentials", () => {
  const CREDENTIAL_SHAPES = [/\bli_at\b/i, /jsessionid/i, /\bcookie/i, /session[_-]?token/i, /\bpassword\b/i, /csrf[_-]?token/i, /\bli_rm\b/i];

  it("no LinkedIn table has a credential-shaped column, and no LinkedIn type carries one", () => {
    for (const f of LINKEDIN_MIGRATIONS) {
      const sql = readFileSync(f, "utf8").replace(/--[^\n]*/g, "");
      for (const re of CREDENTIAL_SHAPES) expect(sql, `${rel(f)} ${re}`).not.toMatch(re);
    }
    const types = readFileSync(path.join(ROOT, "src/lib/supabase/types.ts"), "utf8");
    const linkedinBlock = types.slice(types.indexOf("export type LinkedInSourceType"));
    expect(linkedinBlock.length).toBeGreaterThan(1000);
    for (const re of CREDENTIAL_SHAPES) expect(linkedinBlock, `types ${re}`).not.toMatch(re);
  });

  it("the LinkedIn Sales code never asks for or stores a LinkedIn login", () => {
    for (const f of LINKEDIN_CODE) {
      const src = readFileSync(f, "utf8");
      for (const re of CREDENTIAL_SHAPES) {
        // A credential-like URL is REFUSED by the normaliser; that refusal is the one allowed mention.
        const stripped = src.replace(/credential_like|credential-like|REFUSAL_LABELS[^\n]*/g, "");
        if (f.endsWith("profile-url.ts") || f.endsWith("profile-url.test.ts")) continue;
        expect(stripped, `${rel(f)} ${re}`).not.toMatch(re);
      }
    }
  });
});

describe("no undocumented LinkedIn endpoint and no LinkedIn HTTP client", () => {
  const ALLOWED = [
    /https:\/\/www\.linkedin\.com\/oauth\/v2\/(authorization|accessToken)/,
    /https:\/\/api\.linkedin\.com\/v2\/userinfo/,
    /https:\/\/www\.linkedin\.com\/in\//,
    /linkedin\.com\/(in|company|school|pub|jobs|posts|feed|legal|help|developers)?/,
  ];
  const UNDOCUMENTED = [/\/voyager\//i, /voyagerIdentity/i, /sales-api/i, /\/uas\//i, /\/checkpoint\//i, /linkedin\.com\/messaging/i, /\/mynetwork\//i, /rest\/invitations/i];

  it("every linkedin.com reference in src is an OAuth endpoint, the userinfo endpoint or a public profile URL shape", () => {
    for (const f of SRC) {
      const src = readFileSync(f, "utf8");
      for (const re of UNDOCUMENTED) expect(src, `${rel(f)} ${re}`).not.toMatch(re);
      const hosts = src.match(/https?:\/\/[a-z0-9.-]*linkedin\.com[^\s"'`)]*/gi) ?? [];
      for (const url of hosts) {
        const ok = /^https:\/\/www\.linkedin\.com\/oauth\/v2\/(authorization|accessToken)/.test(url)
          || /^https:\/\/api\.linkedin\.com\/v2\/userinfo/.test(url)
          || /^https:\/\/(www\.)?linkedin\.com\/in\//.test(url)
          || /^https:\/\/(www\.)?linkedin\.com\/(legal|help|developers|company|pub|posts|feed)/.test(url)
          // LinkedIn's documented share link: the operator opens it in their own browser and posts themselves.
          || /^https:\/\/www\.linkedin\.com\/sharing\/share-offsite\//.test(url)
          || /^https:\/\/(www\.|[a-z]{2}\.|m\.)?linkedin\.com\/?$/.test(url)
          || /^https:\/\/learn\.microsoft\.com/.test(url);
        expect(ok, `${rel(f)}: ${url}`).toBe(true);
      }
    }
    expect(ALLOWED.length).toBeGreaterThan(0);
  });

  it("the LinkedIn Sales code has no HTTP client at all", () => {
    for (const f of LINKEDIN_CODE) {
      const src = readFileSync(f, "utf8");
      expect(src, rel(f)).not.toMatch(/\bfetch\s*\(/);
      expect(src, rel(f)).not.toMatch(/from ["'](node:)?https?["']|from ["']axios["']|from ["']undici["']|from ["']got["']/);
      expect(src, rel(f)).not.toMatch(/new XMLHttpRequest|WebSocket\(/);
    }
    expect(LINKEDIN_CODE.length).toBeGreaterThan(20);
  });
});

describe("no automatic LinkedIn member action", () => {
  const MARKERS = [
    /\b(auto[_-]?connect|autoConnect|sendConnectionRequest|sendInvitation|sendMessage|sendInMail|autoLike|likePost|autoFollow|followProfile|unfollowProfile|viewProfile|endorseSkill|sendEndorsement|autoEngage|warmUp|warm_up)\b/,
    /kind in \([^)]*'auto/i,
    /'automatic_/,
    /"automatic_/,
  ];

  it("no marker of an automatic member action exists in the LinkedIn Sales code or migrations", () => {
    for (const f of [...LINKEDIN_CODE, ...LINKEDIN_MIGRATIONS]) {
      const src = readFileSync(f, "utf8");
      for (const re of MARKERS) expect(src, `${rel(f)} ${re}`).not.toMatch(re);
    }
  });

  it("the closed step-kind set in SQL, in TypeScript and in the labels agree, and none is automatic", () => {
    const sql = readFileSync(path.join(ROOT, "supabase/migrations/20260917000001_linkedin_sales_workspace.sql"), "utf8");
    const block = /kind text not null check \(kind in \(([^)]*)\)\)/.exec(sql);
    expect(block, "step kind CHECK found").toBeTruthy();
    const sqlKinds = [...block![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    const state = readFileSync(path.join(ROOT, "src/core/linkedin-sales/state.ts"), "utf8");
    const tsBlock = /export const SEQUENCE_STEP_KINDS[^=]*= \[([^\]]*)\]/.exec(state);
    const tsKinds = [...tsBlock![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(tsKinds).toEqual(sqlKinds);
    expect(sqlKinds).toEqual(["authorized_email", "internal_note", "manual_connection_request", "manual_linkedin_message", "manual_profile_review", "wait"]);
    for (const k of sqlKinds) expect(k).not.toMatch(/auto|api|bot/);
  });

  it("the publishing scheduler still treats LinkedIn as not autonomous", () => {
    const files = SRC.filter((f) => readFileSync(f, "utf8").includes("SCHEDULER_AUTONOMOUS_PLATFORMS"));
    expect(files.length).toBeGreaterThan(0);
    const def = files.map((f) => readFileSync(f, "utf8")).find((s) => /export const SCHEDULER_AUTONOMOUS_PLATFORMS/.test(s));
    expect(def, "definition found").toBeTruthy();
    const list = /export const SCHEDULER_AUTONOMOUS_PLATFORMS[\s\S]*?\[([^\]]*)\]/.exec(def!);
    expect(list, "list parsed").toBeTruthy();
    expect(list![1]).not.toContain("linkedin");
  });
});

describe("the OAuth scope and the capability registry agree", () => {
  it("the installed LinkedIn application asks for identity scopes only, and the registry says so", () => {
    const provider = readFileSync(path.join(ROOT, "src/core/platform-oauth/oauth-provider.ts"), "utf8");
    const start = provider.indexOf("linkedin: {");
    expect(start).toBeGreaterThan(0);
    const block = provider.slice(start, provider.indexOf("\n  },", start));
    const scopes = [...block.matchAll(/scope:\s*"([a-z_.]+)"|"(openid|profile|email|w_member_social|r_liteprofile|r_emailaddress|w_organization_social|r_organization_social)"/g)]
      .map((m) => m[1] ?? m[2]).filter(Boolean);
    expect(new Set(scopes)).toEqual(new Set(["openid", "profile"]));
    // No write, network or messaging scope anywhere in the provider file.
    expect(provider).not.toMatch(/w_member_social|r_1st_connections|w_messages|r_messages|rw_ads|r_network/);

    const registry = readFileSync(path.join(ROOT, "src/core/linkedin-sales/capabilities.ts"), "utf8");
    const approved = [...registry.matchAll(/status: "official_api_approved"/g)].length;
    expect(approved).toBe(1);
    expect(registry).toMatch(/name: "identity_display",\s*status: "official_api_approved"/);
    expect(registry).toMatch(/requiredScopes: \["openid", "profile"\]/);
  });

  it("the cron entry, the route file and the middleware's public list agree", () => {
    const vercel = JSON.parse(readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
    const entry = vercel.crons.find((c: { path: string }) => c.path === "/api/linkedin/tick");
    expect(entry).toBeTruthy();
    expect(existsSync(path.join(ROOT, "src/app/api/linkedin/tick/route.ts"))).toBe(true);
    const middleware = readFileSync(path.join(ROOT, "src/lib/supabase/middleware.ts"), "utf8");
    expect(middleware).toContain('"/api/linkedin/tick"');
    // Nothing else under /api/linkedin is public.
    expect(middleware).not.toMatch(/"\/api\/linkedin",?\s*$/m);
    const route = readFileSync(path.join(ROOT, "src/app/api/linkedin/tick/route.ts"), "utf8");
    expect(route).toContain("authorizeCronRequest(request)");
  });
});
