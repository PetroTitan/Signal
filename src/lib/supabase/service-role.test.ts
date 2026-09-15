import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createSupabaseServiceRoleClient, noStoreFetch } from "./service-role";

/**
 * Every request the service-role client makes bypasses the platform's
 * Data Cache, and the wrapper that guarantees it changes nothing else
 * about the request.
 *
 * PRODUCTION, 2026-09-15 15:35:47Z (Vercel request
 * 7ggxw-1789486547108-3213ab3ab693): supabase-js used the global fetch
 * with no cache directive; inside a GET route handler Next stored and
 * replayed the identity's token row across invocations.
 */

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://service-role-test.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.anon-signature-test",
  SUPABASE_SERVICE_ROLE_KEY: "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.service-signature-test",
};
const saved: Record<string, string | undefined> = {};
const originalFetch = globalThis.fetch;

interface Seen {
  url: string;
  init: RequestInit | undefined;
}
let seen: Seen[] = [];

function recordingFetch(body: unknown = []) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), init });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

beforeAll(() => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
afterEach(() => {
  seen = [];
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

describe("noStoreFetch", () => {
  it("forces cache: no-store and preserves every other RequestInit field, including the signal", async () => {
    globalThis.fetch = recordingFetch();
    const controller = new AbortController();
    const headers = { "x-test": "1", Authorization: "Bearer not-logged" };
    await noStoreFetch("https://example.test/x", {
      method: "PATCH",
      headers,
      body: '{"a":1}',
      signal: controller.signal,
      redirect: "manual",
      keepalive: true,
    });
    expect(seen).toHaveLength(1);
    const init = seen[0].init!;
    expect(init.cache).toBe("no-store");
    expect(init.method).toBe("PATCH");
    expect(init.headers).toBe(headers);
    expect(init.body).toBe('{"a":1}');
    expect(init.signal).toBe(controller.signal);
    expect(init.redirect).toBe("manual");
    expect(init.keepalive).toBe(true);
  });

  it("overrides a caller-supplied cache mode: nothing from this client may be stored", async () => {
    globalThis.fetch = recordingFetch();
    await noStoreFetch("https://example.test/y", { cache: "force-cache" });
    expect(seen[0].init?.cache).toBe("no-store");
  });

  it("resolves the GLOBAL fetch at call time, not at module load", async () => {
    const a = recordingFetch();
    globalThis.fetch = a;
    await noStoreFetch("https://example.test/a");
    const first = seen.length;
    globalThis.fetch = recordingFetch();
    await noStoreFetch("https://example.test/b");
    expect(seen.length).toBe(first + 1);
  });
});

describe("createSupabaseServiceRoleClient", () => {
  it("sends every PostgREST read with cache: no-store, the service key as apikey, and a Bearer Authorization", async () => {
    globalThis.fetch = recordingFetch([{ id: "x", token_generation: 3 }]);
    const client = createSupabaseServiceRoleClient();
    expect(client).not.toBeNull();
    const { data, error } = await client!
      .from("platform_connections")
      .select("id, token_generation")
      .eq("workspace_id", "ws")
      .eq("id", "x")
      .maybeSingle();
    expect(error).toBeNull();
    expect(data).toEqual({ id: "x", token_generation: 3 });
    expect(seen).toHaveLength(1);
    const { url, init } = seen[0];
    expect(url).toMatch(/^https:\/\/service-role-test\.supabase\.co\/rest\/v1\/platform_connections\?/);
    expect(init?.cache).toBe("no-store");
    expect((init?.method ?? "GET").toUpperCase()).toBe("GET");
    const h = new Headers(init?.headers);
    expect(h.get("apikey")).toBe(ENV.SUPABASE_SERVICE_ROLE_KEY);
    expect(h.get("authorization")).toBe(`Bearer ${ENV.SUPABASE_SERVICE_ROLE_KEY}`);
    expect(h.get("x-signal-service-role")).toBe("signal-server-worker");
  });

  it("sends an RPC as a POST with its JSON body, still cache: no-store, and carries an abort signal through", async () => {
    globalThis.fetch = recordingFetch([{ verdict: "acquired" }]);
    const client = createSupabaseServiceRoleClient()!;
    const controller = new AbortController();
    const { error } = await client
      .rpc("acquire_bluesky_refresh_lease", { p_workspace_id: "ws", p_owner: "o", p_observed_generation: 3 })
      .abortSignal(controller.signal);
    expect(error).toBeNull();
    const { url, init } = seen[0];
    expect(url).toBe("https://service-role-test.supabase.co/rest/v1/rpc/acquire_bluesky_refresh_lease");
    expect(init?.method).toBe("POST");
    expect(init?.cache).toBe("no-store");
    expect(JSON.parse(String(init?.body))).toEqual({ p_workspace_id: "ws", p_owner: "o", p_observed_generation: 3 });
    expect(init?.signal).toBe(controller.signal);
  });

  it("sends a PATCH with return=representation as a POST-class request that is still cache: no-store", async () => {
    globalThis.fetch = recordingFetch([{ id: "c", status: "active" }]);
    const client = createSupabaseServiceRoleClient()!;
    await client.from("bluesky_follow_campaigns").update({ status: "active" }).eq("id", "c").select("*");
    const { init } = seen[0];
    expect(init?.method).toBe("PATCH");
    expect(init?.cache).toBe("no-store");
    expect(new Headers(init?.headers).get("prefer")).toMatch(/return=representation/);
  });

  it("never logs the key, the Authorization header, or a response body", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    globalThis.fetch = recordingFetch([{ access_token_encrypted: "enc-secret" }]);
    const client = createSupabaseServiceRoleClient()!;
    await client.from("platform_connections").select("access_token_encrypted").eq("id", "x").maybeSingle();
    const everything = [info, log, warn, error]
      .flatMap((s) => s.mock.calls)
      .map((c) => c.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "))
      .join("\n");
    expect(everything).not.toContain(ENV.SUPABASE_SERVICE_ROLE_KEY);
    expect(everything).not.toContain("Bearer ");
    expect(everything).not.toContain("enc-secret");
  });

  it("returns null without the service key — no silent fallback to a cached or cookie client", () => {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      expect(createSupabaseServiceRoleClient()).toBeNull();
    } finally {
      process.env.SUPABASE_SERVICE_ROLE_KEY = key;
    }
  });
});
