import "server-only";
/**
 * Phase 2 — orchestrator-facing media resolver.
 *
 * Sits between the publish orchestrators (Bluesky / X) and the pure
 * `prepareProviderMedia` decision layer. It wires the sharp-backed
 * `MediaTransformer` in, persists the resulting derivative descriptor
 * onto the creative's metadata JSONB, and hands the caller one of:
 *
 *   - `ready`      — original creative is safe; publish it unchanged.
 *   - `derivative` — a provider-safe derivative was produced/reused;
 *                    the returned `creative` points at the derivative
 *                    bytes (URL + size + mime rewritten). The ORIGINAL
 *                    creative row is never mutated; only metadata gains
 *                    a `provider_derivatives[platform]` descriptor.
 *   - `blocked`    — cannot prepare safely (too large + no transform,
 *                    transform failed, animated GIF, unsupported format,
 *                    video). The caller MUST NOT call the provider
 *                    publish API and MUST NOT downgrade to text-only.
 *
 * The original creative is preserved end-to-end. Metadata persistence
 * is best-effort: a write hiccup is logged, never fatal to the publish.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  PublishCreative,
  PublishOutcome,
  PublishPlatform,
  PublishRequest,
} from "@/core/publishing/publishing-types";
import { publishBlocked } from "@/core/publishing/publishing-result";
import { prepareProviderMedia } from "./provider-media-prep";
import {
  createImageDerivativeTransformer,
  preparedToRecord,
  type ProviderDerivativeRecord,
} from "./image-derivative-transformer";

export type ResolveProviderMediaResult =
  | {
      kind: "ready";
      creative: PublishCreative | null;
      metadata: Record<string, unknown>;
    }
  | {
      kind: "derivative";
      creative: PublishCreative;
      metadata: Record<string, unknown>;
    }
  | { kind: "blocked"; outcome: PublishOutcome };

export interface ResolveProviderMediaInput {
  platform: PublishPlatform;
  request: PublishRequest;
  /** Service-role in the scheduler tick; cookie-aware in manual publish. */
  db?: SupabaseClient;
  /** Test seam — skip the real sharp engine + storage. */
  transformerFactory?: typeof createImageDerivativeTransformer;
}

function effectiveUrl(creative: PublishCreative): string | null {
  const u = creative.assetUrl ?? creative.sourceUrl ?? null;
  return u && u.trim().length > 0 ? u : null;
}

/**
 * Read the cached derivative descriptor for this platform off the
 * creative row's metadata (so we can reuse instead of regenerating).
 * Returns null on any read failure — dedup is an optimization, never a
 * correctness requirement.
 */
async function readCachedDerivative(
  db: SupabaseClient,
  workspaceId: string,
  creativeId: string,
  platform: string,
): Promise<ProviderDerivativeRecord | null> {
  try {
    const { data } = await db
      .from("weekly_plan_item_creatives")
      .select("metadata")
      .eq("workspace_id", workspaceId)
      .eq("id", creativeId)
      .maybeSingle();
    const metadata =
      (data as { metadata?: Record<string, unknown> | null } | null)?.metadata ??
      null;
    const derivatives =
      (metadata?.provider_derivatives as
        | Record<string, ProviderDerivativeRecord>
        | undefined) ?? undefined;
    return derivatives?.[platform] ?? null;
  } catch {
    return null;
  }
}

export async function resolveProviderMediaForPublish(
  input: ResolveProviderMediaInput,
): Promise<ResolveProviderMediaResult> {
  const { platform, request } = input;
  const creative = request.creative ?? null;

  // No creative → nothing to prepare; existing text-only behavior.
  if (!creative) {
    return { kind: "ready", creative: null, metadata: {} };
  }

  // Resolve a Supabase client for derivative storage + metadata. The
  // scheduler passes its service-role client; manual publish leaves it
  // unset and we lazily build the cookie-aware one. If neither is
  // available (e.g. misconfigured env), we DEGRADE GRACEFULLY: prep
  // runs without a transformer, so an oversized image blocks (Phase 1
  // behaviour) rather than crashing — never a text-only downgrade.
  let db: SupabaseClient | null = input.db ?? null;
  if (!db) {
    try {
      const { createSupabaseServerClient } = await import("@/lib/supabase");
      db = createSupabaseServerClient();
    } catch {
      db = null;
    }
  }

  const factory = input.transformerFactory ?? createImageDerivativeTransformer;
  const url = effectiveUrl(creative);

  // Build the transformer only when we have BOTH a fetchable source URL
  // and a storage client. Without either, prep falls back to a clear
  // "too large" block rather than attempting generation.
  const transformer =
    url && db
      ? factory({
          workspaceId: request.workspaceId,
          sourceUrl: url,
          originalCreativeId: creative.id,
          db,
          cachedDerivative: await readCachedDerivative(
            db,
            request.workspaceId,
            creative.id,
            platform,
          ),
        })
      : undefined;

  const prep = await prepareProviderMedia(
    {
      platform,
      mimeType: creative.mimeType ?? null,
      sizeBytes: creative.sizeBytes ?? null,
      creativeType: creative.creativeType,
      originalCreativeId: creative.id,
    },
    { transformer },
  );

  if (prep.status === "blocked") {
    return {
      kind: "blocked",
      outcome: publishBlocked(
        prep.reasonCode ?? "media_too_large_for_platform",
        `${platformLabel(platform)}: ${prep.reasonDetail ?? "Creative cannot be prepared for this platform."}`,
        {
          creative_id: creative.id,
          media_mode: `${platform}_image`,
          ...prep.metadata,
        },
      ),
    };
  }

  if (prep.status === "derivative" && prep.derivative) {
    const d = prep.derivative;
    const record = preparedToRecord(d);

    // Persist the descriptor onto the creative metadata (best-effort).
    if (db) {
      try {
        const { recordProviderDerivative } = await import(
          "@/repositories/weekly-plan-creative-repository"
        );
        await recordProviderDerivative({
          workspaceId: request.workspaceId,
          creativeId: creative.id,
          platform,
          descriptor: record as unknown as Record<string, unknown>,
          db,
        });
      } catch (err) {
        console.error(
          "[resolve-provider-derivative] metadata persist failed (non-fatal)",
          err,
        );
      }
    }

    const derivativeUrl = d.publicUrl ?? null;
    if (!derivativeUrl) {
      // We produced a derivative but have no URL to publish it from —
      // block rather than fall back to the oversized original.
      return {
        kind: "blocked",
        outcome: publishBlocked(
          "media_derivative_failed",
          `${platformLabel(platform)}: generated a provider-safe image but could not resolve its URL. Re-upload the creative and try again.`,
          { creative_id: creative.id, media_mode: `${platform}_image` },
        ),
      };
    }

    // Rewrite the creative to point at the derivative bytes. The
    // ORIGINAL row is untouched; this is an in-memory publish payload.
    const rewritten: PublishCreative = {
      ...creative,
      assetUrl: derivativeUrl,
      sourceUrl: null,
      mimeType: d.mimeType,
      sizeBytes: d.sizeBytes,
    };

    return {
      kind: "derivative",
      creative: rewritten,
      metadata: {
        media_mode: `${platform}_image`,
        ...prep.metadata,
        derivative_used: true,
        derivative_size_bytes: d.sizeBytes,
        derivative_storage_path: d.storageRef,
        original_creative_id: creative.id,
        provider_media_limit_bytes: prep.providerLimitBytes,
      },
    };
  }

  // Ready — original creative is safe for this platform.
  return {
    kind: "ready",
    creative,
    metadata: { media_mode: `${platform}_image`, ...prep.metadata },
  };
}

function platformLabel(platform: PublishPlatform): string {
  switch (platform) {
    case "bluesky":
      return "Bluesky";
    case "x":
      return "X";
    default:
      return platform;
  }
}
