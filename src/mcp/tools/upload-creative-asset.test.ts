import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { uploadCreativeAsset } from "./prepare-tools";
import type { ToolContext } from "../tool-context";
import {
  parseUploadCreativeAsset,
  type UploadCreativeAssetArgs,
} from "../schemas";

/**
 * Focused tests for the smallest-safe MCP asset-ingestion flow.
 *
 * Pinned contracts:
 *   - Reuses the existing `weekly-plan-creatives` Supabase Storage
 *     bucket + path convention.
 *   - Reuses the existing `validateUpload` MIME + size whitelist.
 *   - Persists `source_type='uploaded'` ALWAYS (the schema parser
 *     refuses `generated` at the boundary — Signal does not
 *     generate; that label is reserved for an in-house generator
 *     that doesn't exist).
 *   - Persists `status='pending_review'` — NEVER auto-approves.
 *     The operator-driven server-action upload path auto-approves
 *     because the operator IS the uploader; the MCP path is
 *     Codex/Claude-driven and MUST be reviewed.
 *   - Writes `asset_url` AND `storage_path` so every reader of the
 *     row (publisher, readiness module, UI) sees a real asset.
 *   - Stamps `metadata.origin` so audit can distinguish AI-external
 *     vs operator-uploaded files.
 *   - Does NOT touch execution_items, publish_history, scheduler,
 *     provider adapters, or platform routing.
 */

// =====================================================================
// In-memory Supabase fake — only the surfaces this handler touches.
// =====================================================================

interface FakeStore {
  weekly_plan_items: Array<Record<string, unknown>>;
  weekly_plan_item_creatives: Array<Record<string, unknown>>;
  activity_events: Array<Record<string, unknown>>;
  /**
   * Supabase Storage shim — keyed by `<bucket>:<objectName>`. The
   * real bucket isn't reachable from the test environment; we
   * track every upload + removal so assertions can confirm the
   * file landed at the right path.
   */
  storage: Map<string, { buffer: Buffer; contentType: string }>;
  /** Track upload failures injected by the test. */
  uploadShouldFail?: string | null;
}

function emptyStore(): FakeStore {
  return {
    weekly_plan_items: [],
    weekly_plan_item_creatives: [],
    activity_events: [],
    storage: new Map(),
    uploadShouldFail: null,
  };
}

let idCounter = 0;
function fakeId(prefix: string): string {
  idCounter++;
  const hex = idCounter.toString(16).padStart(12, "0");
  return `${prefix}-${hex}`;
}

function makeFakeClient(store: FakeStore): SupabaseClient {
  function tableChain(table: keyof FakeStore) {
    const filters: Array<(row: Record<string, unknown>) => boolean> = [];
    let insertRow: Record<string, unknown> | null = null;
    const api = {
      select(_cols: string) {
        return api;
      },
      eq(field: string, value: unknown) {
        filters.push((r) => r[field] === value);
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
          const row = { id: fakeId(table as string), ...insertRow };
          (store[table] as Record<string, unknown>[]).push(row);
          return { data: row, error: null };
        }
        const rows = (store[table] as Record<string, unknown>[]).filter((r) =>
          filters.every((f) => f(r)),
        );
        return { data: rows[0] ?? null, error: null };
      },
      then(
        resolve: (
          value: { data: null | Record<string, unknown>[]; error: null },
        ) => void,
      ) {
        if (insertRow !== null) {
          const row = { id: fakeId(table as string), ...insertRow };
          (store[table] as Record<string, unknown>[]).push(row);
          resolve({ data: null, error: null });
          return;
        }
        const rows = (store[table] as Record<string, unknown>[]).filter((r) =>
          filters.every((f) => f(r)),
        );
        resolve({ data: rows, error: null });
      },
      insert(row: Record<string, unknown>) {
        insertRow = row;
        return api;
      },
    };
    return api;
  }

  function storageBucket(bucket: string) {
    return {
      async upload(
        objectName: string,
        buf: Buffer,
        opts: { contentType: string; cacheControl?: string; upsert?: boolean },
      ) {
        if (store.uploadShouldFail) {
          return {
            data: null,
            error: { message: store.uploadShouldFail } as unknown as Error,
          };
        }
        const key = `${bucket}:${objectName}`;
        store.storage.set(key, {
          buffer: buf,
          contentType: opts.contentType,
        });
        return { data: { path: objectName }, error: null };
      },
      getPublicUrl(objectName: string) {
        return {
          data: {
            publicUrl: `https://storage.example.com/${bucket}/${objectName}`,
          },
        };
      },
      async remove(objectNames: string[]) {
        for (const name of objectNames) {
          store.storage.delete(`${bucket}:${name}`);
        }
        return { data: null, error: null };
      },
    };
  }

  return {
    from: tableChain,
    storage: { from: storageBucket },
  } as unknown as SupabaseClient;
}

const WS = "ws-1";
const TOKEN_ID = "tok-1";
const ITEM_ID = "11111111-2222-3333-4444-555555555555";

function ctxWith(store: FakeStore): ToolContext {
  return {
    workspaceId: WS,
    operatorTokenId: TOKEN_ID,
    scopes: ["weekly_plans:write_pending"],
    token: { id: TOKEN_ID, workspaceId: WS } as unknown as ToolContext["token"],
    db: makeFakeClient(store),
  };
}

/** A 1×1 transparent PNG, base64-encoded. ~ 95 bytes decoded. */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";

function baseArgs(
  over: Partial<UploadCreativeAssetArgs> = {},
): UploadCreativeAssetArgs {
  return {
    weekly_plan_item_id: ITEM_ID,
    source_type: "uploaded",
    mime_type: "image/png",
    file_base64: TINY_PNG_BASE64,
    alt_text: "Telegram channel banner",
    prompt: "A wide-angle mountain at dawn",
    aspect_ratio: "16:9",
    origin: "ai_external",
    ...over,
  };
}

function seedItem(store: FakeStore, itemId: string = ITEM_ID): void {
  store.weekly_plan_items.push({
    id: itemId,
    workspace_id: WS,
    content_type: "post",
  });
}

beforeEach(() => {
  idCounter = 0;
});

afterEach(() => {
  // Nothing to restore.
});

// =====================================================================
// Schema parser
// =====================================================================

describe("parseUploadCreativeAsset", () => {
  it("accepts the canonical shape", () => {
    const parsed = parseUploadCreativeAsset(baseArgs());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.source_type).toBe("uploaded");
    expect(parsed.value.mime_type).toBe("image/png");
    expect(parsed.value.origin).toBe("ai_external");
  });

  it("rejects source_type='generated' at the boundary (Signal does not generate)", () => {
    const parsed = parseUploadCreativeAsset({
      ...baseArgs(),
      source_type: "generated",
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toContain("source_type_must_be_uploaded");
  });

  it("rejects source_type='planned' (use signal.weekly_plan.attach_creative instead)", () => {
    const parsed = parseUploadCreativeAsset({
      ...baseArgs(),
      source_type: "planned",
    });
    expect(parsed.ok).toBe(false);
  });

  it("rejects missing file_base64", () => {
    const parsed = parseUploadCreativeAsset({
      ...baseArgs(),
      file_base64: "",
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toContain("file_base64_required");
  });

  it("rejects missing mime_type", () => {
    const parsed = parseUploadCreativeAsset({
      ...baseArgs(),
      mime_type: "",
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toContain("mime_type_required");
  });

  it("rejects malformed weekly_plan_item_id", () => {
    const parsed = parseUploadCreativeAsset({
      ...baseArgs(),
      weekly_plan_item_id: "not-a-uuid",
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toContain("weekly_plan_item_id_invalid");
  });

  it("rejects unknown origin values", () => {
    const parsed = parseUploadCreativeAsset({
      ...baseArgs(),
      origin: "bigfoot",
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toContain("origin_invalid");
  });

  it("rejects invalid creative_type values", () => {
    const parsed = parseUploadCreativeAsset({
      ...baseArgs(),
      creative_type: "audio",
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toContain("creative_type_invalid");
  });

  it("accepts omitted optional fields", () => {
    const parsed = parseUploadCreativeAsset({
      weekly_plan_item_id: ITEM_ID,
      source_type: "uploaded",
      mime_type: "image/png",
      file_base64: TINY_PNG_BASE64,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.alt_text).toBeNull();
    expect(parsed.value.prompt).toBeNull();
    expect(parsed.value.aspect_ratio).toBeNull();
    expect(parsed.value.origin).toBeNull();
  });
});

// =====================================================================
// Handler — success path
// =====================================================================

describe("uploadCreativeAsset — success path", () => {
  it("uploads to the existing bucket + persists the creative as pending_review", async () => {
    const store = emptyStore();
    seedItem(store);

    const result = await uploadCreativeAsset(ctxWith(store), baseArgs());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Storage: exactly one object landed at the expected path shape.
    expect(store.storage.size).toBe(1);
    const [key] = Array.from(store.storage.keys());
    expect(key.startsWith(`weekly-plan-creatives:${WS}/${ITEM_ID}/`)).toBe(true);
    expect(key.endsWith(".png")).toBe(true);

    // Row: exactly one creative row with source_type=uploaded and
    // status=pending_review (NOT approved).
    expect(store.weekly_plan_item_creatives.length).toBe(1);
    const row = store.weekly_plan_item_creatives[0];
    expect(row.workspace_id).toBe(WS);
    expect(row.weekly_plan_item_id).toBe(ITEM_ID);
    expect(row.source_type).toBe("uploaded");
    expect(row.status).toBe("pending_review");
    expect(row.creative_type).toBe("image");
    expect(row.alt_text).toBe("Telegram channel banner");
    expect(row.prompt).toBe("A wide-angle mountain at dawn");

    // asset_url + storage_path both present — readiness module will
    // see asset_present=true.
    const assetUrl = row.asset_url as string;
    const storagePath = row.storage_path as string;
    expect(typeof assetUrl).toBe("string");
    expect(assetUrl.length).toBeGreaterThan(0);
    expect(typeof storagePath).toBe("string");
    expect(storagePath).toMatch(
      new RegExp(
        `^${WS}/${ITEM_ID}/[0-9a-f-]{36}\\.png$`,
      ),
    );

    // metadata stamps the audit trail.
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.source).toBe("mcp_operation");
    expect(meta.operator_token_id).toBe(TOKEN_ID);
    expect(meta.origin).toBe("ai_external");
    expect(meta.aspect_ratio).toBe("16:9");
    expect(meta.mime_type).toBe("image/png");
    expect(typeof meta.size_bytes).toBe("number");
    expect((meta.size_bytes as number) > 0).toBe(true);

    // Response surfaces the derived readiness state so the caller
    // can confirm without an extra read.
    expect(result.data.readiness_state).toBe("pending_review");
    expect(result.data.asset_present).toBe(true);
    expect(result.data.ready_for_publish).toBe(false);

    // Activity event written.
    expect(store.activity_events.length).toBe(1);
    expect(store.activity_events[0].event_type).toBe(
      "mcp.weekly_plan_item_creative_asset_uploaded",
    );
  });

  it("infers creative_type from mime_type when omitted", async () => {
    const store = emptyStore();
    seedItem(store);
    await uploadCreativeAsset(
      ctxWith(store),
      baseArgs({ creative_type: undefined, mime_type: "image/gif" }),
    );
    const row = store.weekly_plan_item_creatives[0];
    // gif → animation (per creative-upload-policy)
    expect(row.creative_type).toBe("animation");
  });

  it("origin defaults to ai_external when caller omits it", async () => {
    const store = emptyStore();
    seedItem(store);
    await uploadCreativeAsset(
      ctxWith(store),
      baseArgs({ origin: null }),
    );
    const row = store.weekly_plan_item_creatives[0];
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.origin).toBe("ai_external");
  });
});

// =====================================================================
// Handler — refusals + boundary checks
// =====================================================================

describe("uploadCreativeAsset — refusals", () => {
  it("refuses cross-workspace plan_item_id (workspace-scoped lookup)", async () => {
    const store = emptyStore();
    // Item belongs to a DIFFERENT workspace; the handler must not
    // find it.
    store.weekly_plan_items.push({
      id: ITEM_ID,
      workspace_id: "other-ws",
      content_type: "post",
    });

    const result = await uploadCreativeAsset(ctxWith(store), baseArgs());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.summary).toBe(
      "weekly_plan_item not found in this workspace",
    );
    expect(store.storage.size).toBe(0);
    expect(store.weekly_plan_item_creatives.length).toBe(0);
  });

  it("refuses MIME types outside the whitelist (svg)", async () => {
    const store = emptyStore();
    seedItem(store);

    const result = await uploadCreativeAsset(
      ctxWith(store),
      baseArgs({ mime_type: "image/svg+xml" }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.summary.toLowerCase()).toContain("mime");
    // Nothing uploaded, nothing persisted.
    expect(store.storage.size).toBe(0);
    expect(store.weekly_plan_item_creatives.length).toBe(0);
  });

  it("refuses empty / unparseable base64 (defensive after parser)", async () => {
    const store = emptyStore();
    seedItem(store);

    // The schema parser would normally catch the empty-string case;
    // call the handler with a value that parses but decodes empty.
    const result = await uploadCreativeAsset(ctxWith(store), {
      ...baseArgs(),
      file_base64: "====", // valid base64 syntax, zero bytes
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.summary).toBe("file_base64_empty");
    expect(store.storage.size).toBe(0);
    expect(store.weekly_plan_item_creatives.length).toBe(0);
  });

  it("rolls back the storage object when the DB insert fails", async () => {
    // Build a client where the table chain returns an error from
    // single() on weekly_plan_item_creatives. We approximate by
    // making the row fail at the insert step.
    const store = emptyStore();
    seedItem(store);

    // Patch the client so creatives.insert().single() returns
    // {error}. The simplest way: wrap the existing fake.
    const baseClient = makeFakeClient(store) as SupabaseClient;
    const wrappedClient = new Proxy(baseClient, {
      get(target, prop) {
        if (prop === "from") {
          return (table: string) => {
            const chain = (target as unknown as { from(t: string): unknown }).from(
              table,
            ) as Record<string, unknown>;
            if (table === "weekly_plan_item_creatives") {
              const origInsert = chain.insert as (
                row: Record<string, unknown>,
              ) => Record<string, unknown>;
              return {
                ...chain,
                insert: (row: Record<string, unknown>) => {
                  origInsert(row);
                  return {
                    select: () => ({
                      single: async () => ({
                        data: null,
                        error: { message: "fake_insert_error" },
                      }),
                    }),
                  };
                },
              };
            }
            return chain;
          };
        }
        return (target as unknown as Record<string | symbol, unknown>)[
          prop as string | symbol
        ];
      },
    });

    const ctx: ToolContext = {
      workspaceId: WS,
      operatorTokenId: TOKEN_ID,
      scopes: ["weekly_plans:write_pending"],
      token: { id: TOKEN_ID, workspaceId: WS } as unknown as ToolContext["token"],
      db: wrappedClient,
    };

    const result = await uploadCreativeAsset(ctx, baseArgs());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.summary).toContain("fake_insert_error");
    // The storage object was uploaded then removed — net zero.
    expect(store.storage.size).toBe(0);
  });
});

// =====================================================================
// Boundary discipline — what this tool MUST NOT touch
// =====================================================================

describe("uploadCreativeAsset — boundary discipline", () => {
  it("never creates an execution_items row", async () => {
    const store = emptyStore() as FakeStore & {
      execution_items?: unknown[];
    };
    seedItem(store);

    await uploadCreativeAsset(ctxWith(store), baseArgs());

    // No `execution_items` table touched by the handler.
    expect(store.execution_items).toBeUndefined();
  });

  it("never writes status='approved' (operator review required)", async () => {
    const store = emptyStore();
    seedItem(store);
    await uploadCreativeAsset(ctxWith(store), baseArgs());
    expect(store.weekly_plan_item_creatives[0].status).toBe("pending_review");
  });

  it("never writes source_type='generated' (Signal does not generate)", async () => {
    const store = emptyStore();
    seedItem(store);
    await uploadCreativeAsset(ctxWith(store), baseArgs());
    expect(store.weekly_plan_item_creatives[0].source_type).toBe("uploaded");
  });

  it("response never includes binary file bytes (only the storage_path + asset_url)", async () => {
    const store = emptyStore();
    seedItem(store);
    const result = await uploadCreativeAsset(ctxWith(store), baseArgs());
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(TINY_PNG_BASE64);
    // Storage path + asset_url are operator-visible identifiers,
    // not secrets — those are expected in the response.
    expect(serialized).toContain("storage_path");
    expect(serialized).toContain("asset_url");
  });
});

// =====================================================================
// Readiness transition — ties into the PR #135 readiness module
// =====================================================================

describe("uploadCreativeAsset — readiness transition", () => {
  it("turns a previously-blocked plan_item creative state into pending_review with asset_present=true", async () => {
    const store = emptyStore();
    seedItem(store);

    // Before upload: no creative row exists for the item, so
    // readiness derivation would classify the item as having NO
    // creative (downstream callers default to "creative_missing").
    expect(
      store.weekly_plan_item_creatives.filter(
        (r) => r.weekly_plan_item_id === ITEM_ID,
      ).length,
    ).toBe(0);

    const result = await uploadCreativeAsset(ctxWith(store), baseArgs());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // After upload: row exists, readiness state is pending_review,
    // asset_present is true, ready_for_publish is false (still
    // needs operator approval).
    expect(result.data.readiness_state).toBe("pending_review");
    expect(result.data.asset_present).toBe(true);
    expect(result.data.ready_for_publish).toBe(false);
  });
});
