import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { accountsPrepare } from "./prepare-tools";
import type { ToolContext } from "../tool-context";
import type { AccountsPrepareArgs } from "../schemas";

// ---------------------------------------------------------------------
// Fake Supabase chain that tracks every insert/update against an
// in-memory store. Mirrors only the surface accountsPrepare uses:
//   .from(table)
//     .select(cols).eq(...).eq(...).neq(...).eq(...).maybeSingle()
//     .select(cols).eq(...).eq(...).is(...).maybeSingle()
//     .insert(row).select(cols).single()
//     .update(patch).eq(...).eq(...).select(cols).single()
//   .from('activity_events').insert(row)
// ---------------------------------------------------------------------

interface FakeRow {
  id: string;
  workspace_id: string;
  product_id: string | null;
  platform: string;
  handle: string | null;
  display_name: string;
  voice_profile: string | null;
  status: string;
  connection_status: string;
  source: string;
  review_status: string;
  role: string | null;
  created_at: string;
}

interface FakeStore {
  growth_accounts: FakeRow[];
  products: { id: string; workspace_id: string }[];
  activity_events: Record<string, unknown>[];
  nextId: () => string;
}

function makeFakeClient(store: FakeStore): SupabaseClient {
  let counter = 0;
  store.nextId = () =>
    `fake-${String(++counter).padStart(8, "0")}-aaaa-bbbb-cccc-dddddddddddd`;

  function selectChain(table: keyof FakeStore, _cols: string) {
    const filters: Array<(row: FakeRow) => boolean> = [];
    const chain = {
      eq(field: string, value: unknown) {
        filters.push((row) => (row as unknown as Record<string, unknown>)[field] === value);
        return chain;
      },
      neq(field: string, value: unknown) {
        filters.push((row) => (row as unknown as Record<string, unknown>)[field] !== value);
        return chain;
      },
      is(field: string, value: unknown) {
        filters.push((row) => (row as unknown as Record<string, unknown>)[field] === value);
        return chain;
      },
      async maybeSingle() {
        const rows = (store[table] as FakeRow[]).filter((r) =>
          filters.every((f) => f(r)),
        );
        return { data: rows[0] ?? null, error: null };
      },
    };
    return chain;
  }

  function updateChain(
    table: keyof FakeStore,
    patch: Record<string, unknown>,
  ) {
    const filters: Array<(row: FakeRow) => boolean> = [];
    const chain = {
      eq(field: string, value: unknown) {
        filters.push((row) => (row as unknown as Record<string, unknown>)[field] === value);
        return chain;
      },
      select(_cols: string) {
        return {
          async single() {
            const rows = (store[table] as FakeRow[]).filter((r) =>
              filters.every((f) => f(r)),
            );
            const target = rows[0];
            if (!target)
              return { data: null, error: { message: "not_found" } };
            Object.assign(target, patch);
            return { data: target, error: null };
          },
        };
      },
    };
    return chain;
  }

  return {
    from(table: keyof FakeStore) {
      return {
        select(cols: string) {
          return selectChain(table, cols);
        },
        insert(row: Record<string, unknown>) {
          if (table === "growth_accounts") {
            const inserted: FakeRow = {
              id: store.nextId(),
              created_at: new Date().toISOString(),
              ...(row as Partial<FakeRow>),
            } as FakeRow;
            store.growth_accounts.push(inserted);
            return {
              select(_cols: string) {
                return {
                  async single() {
                    return { data: inserted, error: null };
                  },
                };
              },
              // accountsPrepare uses .insert(...) without .select() for
              // activity_events; provide a thenable so `await` resolves.
              then(
                onFulfilled?: (v: { data: null; error: null }) => unknown,
              ) {
                return Promise.resolve({ data: null, error: null }).then(
                  onFulfilled,
                );
              },
            };
          }
          if (table === "activity_events") {
            store.activity_events.push(row);
          }
          return {
            then(onFulfilled?: (v: { data: null; error: null }) => unknown) {
              return Promise.resolve({ data: null, error: null }).then(
                onFulfilled,
              );
            },
          };
        },
        update(patch: Record<string, unknown>) {
          return updateChain(table, patch);
        },
      };
    },
  } as unknown as SupabaseClient;
}

const WORKSPACE_ID = "ws-1";
const OPERATOR_TOKEN_ID = "op-1";

function makeCtx(store: FakeStore): ToolContext {
  return {
    workspaceId: WORKSPACE_ID,
    operatorTokenId: OPERATOR_TOKEN_ID,
    scopes: ["accounts:write_pending"],
    token: { id: OPERATOR_TOKEN_ID } as never,
    db: makeFakeClient(store),
  };
}

function emptyStore(): FakeStore {
  return {
    growth_accounts: [],
    products: [],
    activity_events: [],
    nextId: () => "unused",
  };
}

describe("accountsPrepare — persistence", () => {
  it("persists voice_profile on the inserted growth_account row", async () => {
    const store = emptyStore();
    const args: AccountsPrepareArgs = {
      platform: "x",
      display_name: "WebmasterID — X",
      handle: "@Webmasteridcore",
      voice_profile: "calm, operational, anti-hype",
    };
    const result = await accountsPrepare(makeCtx(store), args);
    expect(result.ok).toBe(true);
    expect(store.growth_accounts).toHaveLength(1);
    expect(store.growth_accounts[0].voice_profile).toBe(
      "calm, operational, anti-hype",
    );
    expect(store.growth_accounts[0].review_status).toBe("pending_review");
  });

  it("creates as 'confirmed' when review_status='confirmed' is passed", async () => {
    const store = emptyStore();
    const result = await accountsPrepare(makeCtx(store), {
      platform: "bluesky",
      display_name: "WebmasterID — Bluesky",
      handle: "@webmasterid.bsky.social",
      voice_profile: "slower, calmer",
      review_status: "confirmed",
    });
    expect(result.ok).toBe(true);
    expect(store.growth_accounts[0].review_status).toBe("confirmed");
    expect(result.ok && result.requires_user_approval).toBe(false);
  });
});

describe("accountsPrepare — idempotency", () => {
  it("does not create a duplicate when called twice with same (platform, handle)", async () => {
    const store = emptyStore();
    const ctx = makeCtx(store);
    const args: AccountsPrepareArgs = {
      platform: "threads",
      display_name: "WebmasterID — Threads",
      handle: "@titan95431",
      voice_profile: "humanized founder voice",
    };
    await accountsPrepare(ctx, args);
    await accountsPrepare(ctx, args);
    expect(store.growth_accounts).toHaveLength(1);
  });

  it("updates display_name and voice_profile on re-run", async () => {
    const store = emptyStore();
    const ctx = makeCtx(store);
    await accountsPrepare(ctx, {
      platform: "linkedin",
      display_name: "WebmasterID — LinkedIn",
      handle: "WebmasterID",
      voice_profile: "first draft",
    });
    const second = await accountsPrepare(ctx, {
      platform: "linkedin",
      display_name: "WebmasterID — LinkedIn (refined)",
      handle: "WebmasterID",
      voice_profile: "calm infra-company voice",
      review_status: "confirmed",
    });
    expect(second.ok).toBe(true);
    expect(store.growth_accounts).toHaveLength(1);
    expect(store.growth_accounts[0].display_name).toBe(
      "WebmasterID — LinkedIn (refined)",
    );
    expect(store.growth_accounts[0].voice_profile).toBe(
      "calm infra-company voice",
    );
    expect(store.growth_accounts[0].review_status).toBe("confirmed");
    expect(second.ok && second.data?.idempotent).toBe(true);
  });

  it("treats null handle as its own identity slot per platform", async () => {
    const store = emptyStore();
    const ctx = makeCtx(store);
    await accountsPrepare(ctx, {
      platform: "telegram",
      display_name: "WebmasterID — Telegram",
      handle: null,
    });
    await accountsPrepare(ctx, {
      platform: "telegram",
      display_name: "WebmasterID — Telegram",
      handle: "@webmasterid",
    });
    expect(store.growth_accounts).toHaveLength(2);
  });
});

describe("accountsPrepare — UPDATE preserves omitted fields", () => {
  it("preserves voice_profile when re-called without one", async () => {
    const store = emptyStore();
    const ctx = makeCtx(store);
    await accountsPrepare(ctx, {
      platform: "x",
      display_name: "WebmasterID — X",
      handle: "@Webmasteridcore",
      voice_profile: "calm, technical, operational",
      review_status: "confirmed",
    });
    // Caller only changes display_name. voice_profile and
    // review_status must not be touched.
    await accountsPrepare(ctx, {
      platform: "x",
      display_name: "WebmasterID — X (renamed)",
      handle: "@Webmasteridcore",
    });
    expect(store.growth_accounts).toHaveLength(1);
    expect(store.growth_accounts[0].voice_profile).toBe(
      "calm, technical, operational",
    );
    expect(store.growth_accounts[0].review_status).toBe("confirmed");
    expect(store.growth_accounts[0].display_name).toBe(
      "WebmasterID — X (renamed)",
    );
  });

  it("clears voice_profile only when caller passes explicit null", async () => {
    const store = emptyStore();
    const ctx = makeCtx(store);
    await accountsPrepare(ctx, {
      platform: "reddit",
      display_name: "WebmasterID — Reddit",
      handle: "u/Webmasterid-core",
      voice_profile: "discussion-first",
    });
    await accountsPrepare(ctx, {
      platform: "reddit",
      display_name: "WebmasterID — Reddit",
      handle: "u/Webmasterid-core",
      voice_profile: null,
    });
    expect(store.growth_accounts[0].voice_profile).toBeNull();
  });

  it("preserves confirmed review_status across no-op updates", async () => {
    const store = emptyStore();
    const ctx = makeCtx(store);
    await accountsPrepare(ctx, {
      platform: "bluesky",
      display_name: "WebmasterID — Bluesky",
      handle: "@webmasterid.bsky.social",
      voice_profile: "slower, calmer",
      review_status: "confirmed",
    });
    const second = await accountsPrepare(ctx, {
      platform: "bluesky",
      display_name: "WebmasterID — Bluesky",
      handle: "@webmasterid.bsky.social",
    });
    expect(store.growth_accounts[0].review_status).toBe("confirmed");
    // requires_user_approval reflects effective review state, even
    // though caller didn't pass it.
    expect(second.ok && second.requires_user_approval).toBe(false);
  });
});

describe("accountsPrepare — activity log", () => {
  it("records mcp.account_profile_create_pending when pending_review", async () => {
    const store = emptyStore();
    await accountsPrepare(makeCtx(store), {
      platform: "reddit",
      display_name: "WebmasterID — Reddit",
      handle: "u/Webmasterid-core",
    });
    expect(store.activity_events).toHaveLength(1);
    expect(store.activity_events[0].event_type).toBe(
      "mcp.account_profile_create_pending",
    );
  });

  it("records mcp.account_profile_created when confirmed", async () => {
    const store = emptyStore();
    await accountsPrepare(makeCtx(store), {
      platform: "reddit",
      display_name: "WebmasterID — Reddit",
      handle: "u/Webmasterid-core",
      review_status: "confirmed",
    });
    expect(store.activity_events[0].event_type).toBe(
      "mcp.account_profile_created",
    );
  });

  it("records mcp.account_profile_updated on idempotent re-run", async () => {
    const store = emptyStore();
    const ctx = makeCtx(store);
    await accountsPrepare(ctx, {
      platform: "devto",
      display_name: "first",
      handle: "petro_hrys",
    });
    await accountsPrepare(ctx, {
      platform: "devto",
      display_name: "second",
      handle: "petro_hrys",
    });
    expect(store.activity_events).toHaveLength(2);
    expect(store.activity_events[1].event_type).toBe(
      "mcp.account_profile_updated",
    );
  });
});
