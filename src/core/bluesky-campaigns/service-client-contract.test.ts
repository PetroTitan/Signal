import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The identity-session coordinator's callers reach the database through
 * ONE client construction — `createSupabaseServiceRoleClient` — and that
 * construction bypasses the platform's Data Cache on every request.
 *
 * A static contract, deliberately: a caller that built its own
 * `createClient(...)` would silently inherit the default fetch and the
 * 2026-09-15 defect with it, and no behavioural test of the coordinator
 * would notice until production did.
 */

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

const SERVICE_ROLE = code(read("src/lib/supabase/service-role.ts"));

describe("the service-role client", () => {
  it("forces cache: no-store through one wrapper that spreads the original RequestInit", () => {
    expect(SERVICE_ROLE).toMatch(/export function noStoreFetch\(/);
    expect(SERVICE_ROLE).toMatch(/return fetch\(input, \{ \.\.\.\(init \?\? \{\}\), cache: "no-store" \}\)/);
    expect(SERVICE_ROLE).toMatch(/global: \{[\s\S]*fetch: noStoreFetch,[\s\S]*\}/);
  });

  it("does not construct a client anywhere else in server code", () => {
    // Every other `createClient`/`createServerClient` in src is the
    // cookie-aware or browser client; none is a second service-role
    // construction that could miss the wrapper.
    const allowed = new Set([
      "src/lib/supabase/service-role.ts",
      "src/lib/supabase/server.ts",
      "src/lib/supabase/browser.ts",
      "src/lib/supabase/middleware.ts",
      "src/app/auth/callback/route.ts",
    ]);
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const out = execSync(
      `git grep -l -E "createClient\\(|createServerClient\\(|createBrowserClient\\(" -- src ':!*.test.ts' ':!*.test.tsx'`,
      { cwd: process.cwd(), encoding: "utf8" },
    );
    const offenders = out.split("\n").map((l) => l.trim()).filter(Boolean).filter((f) => !allowed.has(f));
    expect(offenders).toEqual([]);
  });
});

describe("every coordinator caller uses that client", () => {
  const CALLERS: Record<string, RegExp[]> = {
    "src/app/api/campaigns/bluesky/tick/route.ts": [
      /createSupabaseServiceRoleClient\(\)/,
      /dispatchFairly\(\{\s*db,/,
    ],
    "src/app/api/identity/[identityId]/verify/route.ts": [
      /createSupabaseServiceRoleClient\(\)/,
      /resolveRelationshipSession\(\{[\s\S]*?db: serviceDb \?\? undefined,[\s\S]*?source: "verify-route",/,
    ],
    "src/app/api/identity/[identityId]/bluesky/connect/route.ts": [
      /createSupabaseServiceRoleClient\(\)/,
      /recoverReauthorizedCampaignsForConnectedIdentities\(\{[\s\S]*?db: serviceDb,/,
    ],
    "src/core/publishing/publishing-scheduler.ts": [/createSupabaseServiceRoleClient\(\)/],
    "src/core/publishing/bluesky-publish-orchestrator.ts": [
      /refreshIdentitySession\(\{[\s\S]*?db,[\s\S]*?source: "publisher",/,
    ],
    "src/core/bluesky-campaigns/service-db.server.ts": [/createSupabaseServiceRoleClient\(\)/],
    "src/core/bluesky-campaigns/dispatcher.server.ts": [/source: "follow-dispatcher"/],
    "src/core/bluesky-unfollow/dispatcher.server.ts": [/source: "unfollow-dispatcher"/],
  };

  for (const [file, patterns] of Object.entries(CALLERS)) {
    it(file, () => {
      const src = code(read(file));
      for (const p of patterns) expect(src, String(p)).toMatch(p);
    });
  }

  it("the manual campaign commands reach the coordinator through the service client only", () => {
    for (const file of [
      "src/app/(app)/relationships/campaigns/_actions.ts",
      "src/app/(app)/relationships/unfollow/_actions.ts",
    ]) {
      const src = code(read(file));
      expect(src, file).toMatch(/requireCampaignServiceDb\(\)/);
      expect(src, file).not.toMatch(/createClient\(/);
    }
  });
});
