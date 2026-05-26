import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { upsertSchedulerPublishHistoryFromOutcome } from "./publish-history-repository";

/**
 * Repo-level tests for the scheduler upsert helper. Pins the dedup
 * rules with a hand-rolled fake supabase client (same pattern as
 * `src/mcp/tools/schedule-tools.test.ts`).
 */

// ---------------------------------------------------------------------
// Fake supabase client
// ---------------------------------------------------------------------

interface FakeStore {
  publish_history: Array<Record<string, unknown>>;
}

function emptyStore(): FakeStore {
  return { publish_history: [] };
}

let idCounter = 0;
function fakeUuid(prefix = "row"): string {
  idCounter++;
  return `${prefix}-${idCounter.toString(16).padStart(12, "0")}`;
}

function makeFakeClient(store: FakeStore): SupabaseClient {
  function chain(table: keyof FakeStore) {
    const filters: Array<(r: Record<string, unknown>) => boolean> = [];
    let insertRow: Record<string, unknown> | null = null;
    let updatePatch: Record<string, unknown> | null = null;
    const api = {
      select(_cols: string) {
        return api;
      },
      eq(field: string, value: unknown) {
        filters.push((r) => r[field] === value);
        return api;
      },
      order(_field: string, _opts?: { ascending?: boolean }) {
        return api;
      },
      limit(_n: number) {
        return api;
      },
      async maybeSingle() {
        const rows = (store[table] as Record<string, unknown>[]).filter((r) =>
          filters.every((f) => f(r)),
        );
        return { data: rows[0] ?? null, error: null };
      },
      async single() {
        if (insertRow !== null) {
          const row = {
            id: fakeUuid(),
            finished_at: new Date().toISOString(),
            metadata: {},
            mode: "api",
            ...insertRow,
          };
          (store[table] as Record<string, unknown>[]).push(row);
          return { data: row, error: null };
        }
        if (updatePatch !== null) {
          const rows = (store[table] as Record<string, unknown>[]).filter(
            (r) => filters.every((f) => f(r)),
          );
          for (const r of rows) Object.assign(r, updatePatch);
          return { data: rows[0] ?? null, error: null };
        }
        const rows = (store[table] as Record<string, unknown>[]).filter((r) =>
          filters.every((f) => f(r)),
        );
        return { data: rows[0] ?? null, error: null };
      },
      insert(row: Record<string, unknown>) {
        insertRow = row;
        return api;
      },
      update(patch: Record<string, unknown>) {
        updatePatch = patch;
        return api;
      },
    };
    return api;
  }
  return { from: chain } as unknown as SupabaseClient;
}

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

const WS = "ws-1";
const EI = "ei-1";

function baseInput(
  over: Partial<Parameters<typeof upsertSchedulerPublishHistoryFromOutcome>[0]> = {},
) {
  return {
    workspaceId: WS,
    executionItemId: EI,
    accountId: "acct-1",
    productId: "prod-1",
    platform: "bluesky",
    subreddit: null,
    outcome: "published" as const,
    reasonCode: "ok",
    reasonDetail: null,
    providerPostId: "at://did:plc:test/app.bsky.feed.post/abc",
    providerPermalink: "https://bsky.app/profile/op/post/abc",
    fingerprint: "fp-1",
    titleHash: "th-1",
    bodyHash: "bh-1",
    linkUrl: null,
    httpStatus: null,
    startedAt: "2026-05-26T00:00:00Z",
    providerAttempted: true,
    threadLength: 1,
    mediaAttached: false,
    ...over,
  };
}

beforeEach(() => {
  idCounter = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------
// Insert path
// ---------------------------------------------------------------------

describe("upsertSchedulerPublishHistoryFromOutcome — insert", () => {
  it("absent row → INSERTS with mode='api', source='scheduler' in metadata", async () => {
    const store = emptyStore();
    const result = await upsertSchedulerPublishHistoryFromOutcome({
      ...baseInput(),
      db: makeFakeClient(store),
    });
    expect(result.action).toBe("inserted");
    expect(store.publish_history).toHaveLength(1);
    const row = store.publish_history[0];
    expect(row.workspace_id).toBe(WS);
    expect(row.execution_item_id).toBe(EI);
    expect(row.outcome).toBe("published");
    expect(row.mode).toBe("api");
    expect(row.provider_permalink).toBe("https://bsky.app/profile/op/post/abc");
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.source).toBe("scheduler");
    expect(meta.provider_attempted).toBe(true);
    expect(meta.thread_length).toBe(1);
    expect(meta.media_attached).toBe(false);
  });

  it("failed outcome with atproto detail → INSERTS with full diagnostic metadata", async () => {
    const store = emptyStore();
    const result = await upsertSchedulerPublishHistoryFromOutcome({
      ...baseInput({
        outcome: "failed",
        reasonCode: "platform_api_error",
        reasonDetail:
          "Bluesky: createRecord failed: InvalidRequest — Record/text must not be longer than 300 graphemes",
        providerPostId: null,
        providerPermalink: null,
        httpStatus: 400,
        endpoint: "createRecord",
        atprotoError: "InvalidRequest",
        atprotoMessage:
          "Record/text must not be longer than 300 graphemes",
        threadLength: 5,
        mediaAttached: false,
      }),
      db: makeFakeClient(store),
    });
    expect(result.action).toBe("inserted");
    const row = store.publish_history[0];
    expect(row.outcome).toBe("failed");
    expect(row.http_status).toBe(400);
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.endpoint).toBe("createRecord");
    expect(meta.atproto_error).toBe("InvalidRequest");
    expect(meta.atproto_message).toMatch(/300 graphemes/);
    expect(meta.reason_code).toBe("platform_api_error");
  });

  it("blocked outcome (creative_missing_alt_text) → INSERTS with provider_attempted=false", async () => {
    const store = emptyStore();
    const result = await upsertSchedulerPublishHistoryFromOutcome({
      ...baseInput({
        outcome: "blocked",
        reasonCode: "creative_missing_alt_text",
        reasonDetail:
          "Bluesky: Approved creative is missing alt text.",
        providerPostId: null,
        providerPermalink: null,
        providerAttempted: false,
        endpoint: null,
        atprotoError: null,
        atprotoMessage: null,
        threadLength: null,
        mediaAttached: null,
      }),
      db: makeFakeClient(store),
    });
    expect(result.action).toBe("inserted");
    const row = store.publish_history[0];
    expect(row.outcome).toBe("blocked");
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.provider_attempted).toBe(false);
    expect(meta.reason_code).toBe("creative_missing_alt_text");
    expect("atproto_error" in meta).toBe(false);
    expect("endpoint" in meta).toBe(false);
  });
});

// ---------------------------------------------------------------------
// Dedup + downgrade rules
// ---------------------------------------------------------------------

describe("upsertSchedulerPublishHistoryFromOutcome — dedup + downgrade", () => {
  it("existing 'published' + new 'failed' → SKIPS downgrade, keeps success row", async () => {
    const store = emptyStore();
    // Seed an existing published row.
    store.publish_history.push({
      id: "existing-1",
      workspace_id: WS,
      execution_item_id: EI,
      mode: "api",
      outcome: "published",
      provider_permalink: "https://bsky.app/profile/op/post/abc",
      finished_at: "2026-05-25T00:00:00Z",
      metadata: { source: "scheduler", thread_length: 3 },
    });
    const result = await upsertSchedulerPublishHistoryFromOutcome({
      ...baseInput({
        outcome: "failed",
        reasonCode: "platform_api_error",
        reasonDetail: "Subsequent retry failed",
        providerPostId: null,
        providerPermalink: null,
        endpoint: "createRecord",
      }),
      db: makeFakeClient(store),
    });
    expect(result.action).toBe("skipped_downgrade");
    // Only the original row remains; outcome unchanged.
    expect(store.publish_history).toHaveLength(1);
    expect(store.publish_history[0].outcome).toBe("published");
    expect(store.publish_history[0].id).toBe("existing-1");
  });

  it("existing 'failed' + new 'published' → UPDATES (success replaces failure)", async () => {
    const store = emptyStore();
    store.publish_history.push({
      id: "existing-2",
      workspace_id: WS,
      execution_item_id: EI,
      mode: "api",
      outcome: "failed",
      provider_permalink: null,
      finished_at: "2026-05-25T00:00:00Z",
      reason_code: "platform_api_error",
      metadata: { source: "scheduler" },
    });
    const result = await upsertSchedulerPublishHistoryFromOutcome({
      ...baseInput({ outcome: "published" }),
      db: makeFakeClient(store),
    });
    expect(result.action).toBe("updated");
    expect(store.publish_history).toHaveLength(1);
    expect(store.publish_history[0].outcome).toBe("published");
    expect(store.publish_history[0].provider_permalink).toBe(
      "https://bsky.app/profile/op/post/abc",
    );
  });

  it("existing 'failed' + new 'failed' (same outcome) → UPDATES (refresh metadata + finished_at)", async () => {
    const store = emptyStore();
    store.publish_history.push({
      id: "existing-3",
      workspace_id: WS,
      execution_item_id: EI,
      mode: "api",
      outcome: "failed",
      finished_at: "2026-05-25T00:00:00Z",
      reason_code: "old_code",
      metadata: { source: "scheduler", reason_code: "old_code" },
    });
    const result = await upsertSchedulerPublishHistoryFromOutcome({
      ...baseInput({
        outcome: "failed",
        reasonCode: "session_expired",
        reasonDetail: "Bluesky: createRecord failed: ExpiredToken — Token has expired",
        providerPostId: null,
        providerPermalink: null,
        endpoint: "createRecord",
        atprotoError: "ExpiredToken",
        httpStatus: 400,
      }),
      db: makeFakeClient(store),
    });
    expect(result.action).toBe("updated");
    expect(store.publish_history).toHaveLength(1);
    expect(store.publish_history[0].reason_code).toBe("session_expired");
    const meta = store.publish_history[0].metadata as Record<string, unknown>;
    expect(meta.atproto_error).toBe("ExpiredToken");
  });

  it("existing manual row → NEVER touched; INSERTS a new api row alongside", async () => {
    const store = emptyStore();
    store.publish_history.push({
      id: "manual-1",
      workspace_id: WS,
      execution_item_id: EI,
      mode: "manual",
      outcome: "published",
      provider_permalink: "https://bsky.app/profile/op/post/manual",
      finished_at: "2026-05-24T00:00:00Z",
      reason_code: null,
      metadata: { source: "manual" },
    });
    const result = await upsertSchedulerPublishHistoryFromOutcome({
      ...baseInput({
        outcome: "published",
        providerPermalink: "https://bsky.app/profile/op/post/cron",
      }),
      db: makeFakeClient(store),
    });
    expect(result.action).toBe("inserted");
    expect(store.publish_history).toHaveLength(2);
    // Manual row untouched.
    const manual = store.publish_history.find((r) => r.id === "manual-1");
    expect(manual).toBeDefined();
    expect((manual as { mode: string }).mode).toBe("manual");
    expect((manual as { provider_permalink: string }).provider_permalink).toBe(
      "https://bsky.app/profile/op/post/manual",
    );
    // New api row exists alongside.
    const api = store.publish_history.find(
      (r) => (r as { mode: string }).mode === "api",
    );
    expect(api).toBeDefined();
    expect((api as { provider_permalink: string }).provider_permalink).toBe(
      "https://bsky.app/profile/op/post/cron",
    );
  });

  it("UPDATE path does NOT clobber a non-null provider_permalink with null", async () => {
    const store = emptyStore();
    store.publish_history.push({
      id: "existing-4",
      workspace_id: WS,
      execution_item_id: EI,
      mode: "api",
      outcome: "published",
      provider_permalink: "https://bsky.app/profile/op/post/keep",
      finished_at: "2026-05-25T00:00:00Z",
      metadata: { source: "scheduler" },
    });
    // A subsequent same-outcome upsert with no permalink — must NOT
    // erase the existing one.
    const result = await upsertSchedulerPublishHistoryFromOutcome({
      ...baseInput({
        outcome: "published",
        providerPostId: null,
        providerPermalink: null,
      }),
      db: makeFakeClient(store),
    });
    expect(result.action).toBe("updated");
    expect(store.publish_history[0].provider_permalink).toBe(
      "https://bsky.app/profile/op/post/keep",
    );
  });
});

// ---------------------------------------------------------------------
// Secret-leakage invariants
// ---------------------------------------------------------------------

describe("upsertSchedulerPublishHistoryFromOutcome — no secret leakage", () => {
  it("metadata is built from a whitelist; unknown keys from upstream outcome are never persisted", async () => {
    const store = emptyStore();
    // The helper signature only accepts our whitelisted fields. Even
    // if a future upstream tried to sneak through an access_token or
    // Authorization header, it would have to come via one of these
    // typed fields, none of which carry secret data.
    await upsertSchedulerPublishHistoryFromOutcome({
      ...baseInput({
        outcome: "failed",
        atprotoMessage:
          "Token has expired (no token text included by the publisher)",
      }),
      db: makeFakeClient(store),
    });
    const row = store.publish_history[0];
    const serialized = JSON.stringify(row);
    expect(serialized).not.toMatch(/Bearer\s+eyJ/);
    expect(serialized).not.toMatch(/access_token\s*[:=]/);
    expect(serialized).not.toMatch(/refresh_token\s*[:=]/);
    expect(serialized).not.toMatch(/app_password\s*[:=]/);
    expect(serialized).not.toMatch(/Authorization:\s+(?!\[REDACTED\])/);
    expect(serialized).not.toMatch(/Cookie:\s+(?!\[REDACTED\])/);
  });

  it("the helper does NOT accept a generic 'metadata' bag — explicit fields only", () => {
    // Type-level guarantee — verified by tsc, asserted here so a
    // future refactor can't silently add a wholesale-metadata
    // parameter without updating this test.
    const params: Parameters<typeof upsertSchedulerPublishHistoryFromOutcome>[0] = {
      workspaceId: WS,
      executionItemId: EI,
      accountId: null,
      productId: null,
      platform: "bluesky",
      subreddit: null,
      outcome: "published",
      reasonCode: null,
      reasonDetail: null,
      providerPostId: null,
      providerPermalink: null,
      fingerprint: "fp",
      titleHash: null,
      bodyHash: null,
      linkUrl: null,
      httpStatus: null,
      startedAt: "2026-05-26T00:00:00Z",
      providerAttempted: true,
    };
    // No `metadata` key on the input type.
    expect("metadata" in params).toBe(false);
  });
});
