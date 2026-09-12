import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getSessionInfo, isRefreshableAuthFailure } from "./atproto-graph";

/**
 * "Check account access" must check ACCESS.
 *
 * It resolved the public handle and stopped there, which answers "does
 * this account exist?" — a question nobody was asking. It reported
 * success against an identity whose access token had expired hours
 * earlier, which is why Accounts kept saying "Signed in" while every
 * follow was being refused.
 */

function read(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), "utf8");
}
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("the authenticated session probe", () => {
  it("sends the bearer token to the PDS, not the public AppView", async () => {
    let seenUrl = "";
    let seenAuth = "";
    await getSessionInfo({
      accessJwt: "jwt-1",
      pds: "https://bsky.social",
      fetchImpl: (async (url: string, init?: RequestInit) => {
        seenUrl = url;
        const raw = (init?.headers ?? {}) as Record<string, string>;
        const key = Object.keys(raw).find((k) => k.toLowerCase() === "authorization");
        seenAuth = key ? raw[key] : "";
        return json({ did: "did:plc:actor", handle: "op.bsky.social", active: true });
      }) as unknown as typeof fetch,
    });
    expect(seenUrl).toContain("bsky.social");
    expect(seenUrl).toContain("com.atproto.server.getSession");
    expect(seenAuth).toBe("Bearer jwt-1");
  });

  it("reports the authenticated identity on success", async () => {
    const result = await getSessionInfo({
      accessJwt: "jwt-1",
      fetchImpl: (async () =>
        json({ did: "did:plc:actor", handle: "op.bsky.social", active: true })) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.did).toBe("did:plc:actor");
    expect(result.handle).toBe("op.bsky.social");
    expect(result.active).toBe(true);
  });

  it("classifies the production expired body as refreshable", async () => {
    const result = await getSessionInfo({
      accessJwt: "jwt-1",
      fetchImpl: (async () =>
        json({ error: "ExpiredToken", message: "Token has expired" }, 400)) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("auth");
    expect(isRefreshableAuthFailure(result)).toBe(true);
  });

  it("reports a deactivated account rather than claiming access", async () => {
    const result = await getSessionInfo({
      accessJwt: "jwt-1",
      fetchImpl: (async () =>
        json({ did: "did:plc:actor", handle: "op.bsky.social", active: false })) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.active).toBe(false);
  });
});

describe("the verify route now authenticates", () => {
  const ROUTE = code(read("src/app/api/identity/[identityId]/verify/route.ts"));

  it("resolves the stored session instead of only the public handle", () => {
    expect(ROUTE).toContain("resolveRelationshipSession");
    expect(ROUTE).toContain("getSessionInfo");
  });

  it("performs the same one-time refresh the mutations use", () => {
    expect(ROUTE).toContain("isRefreshableAuthFailure");
    expect(ROUTE).toContain("session.refreshOnce()");
    // Once. There is no loop and no second call.
    expect((ROUTE.match(/refreshOnce\(\)/g) ?? []).length).toBe(1);
  });

  it("tells the operator to sign in again rather than reporting success", () => {
    expect(ROUTE).toContain("reauthorization_required");
  });

  it("does not mistake an outage for a signed-out account", () => {
    expect(ROUTE).toContain("provider_unavailable");
  });
});

describe("campaign activation refuses a dead session", () => {
  for (const file of [
    "src/app/(app)/relationships/campaigns/setup/_actions.ts",
    "src/app/(app)/relationships/campaigns/_actions.ts",
  ]) {
    it(`${file.split("/").slice(-2).join("/")} resolves the session, not just the status column`, () => {
      const src = code(read(file));
      // The status column records what was last written, which is
      // exactly what was stale in production.
      expect(src).toContain("resolveRelationshipSession");
      expect(src).toMatch(/if \(!session\.ok\)/);
    });
  }
});

describe("the refresh path is reached from production code", () => {
  it("refreshOnce has real callers now", () => {
    // It existed unused for the whole life of the subsystem.
    const callers = [
      "src/core/bluesky-relationships/execute-actions.server.ts",
      "src/core/bluesky-campaigns/worker.server.ts",
      "src/app/api/identity/[identityId]/verify/route.ts",
    ];
    for (const f of callers) {
      expect(code(read(f)), f).toContain("refreshOnce()");
    }
  });

  it("neither mutation path can refresh twice", () => {
    for (const f of [
      "src/core/bluesky-relationships/execute-actions.server.ts",
      "src/core/bluesky-campaigns/worker.server.ts",
    ]) {
      const src = code(read(f));
      // Exactly one call site each, and no loop around it.
      expect((src.match(/refreshOnce\(\)/g) ?? []).length, f).toBe(1);
      expect(src, f).not.toMatch(/while\s*\([^)]*refresh/i);
    }
  });
});
