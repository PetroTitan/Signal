/**
 * Phase F6.2 — Bluesky-only operator-bound shape enforcement.
 *
 * Pure helpers (no I/O) that the impure callers use to:
 *
 *   - decide whether operator approval should be REFUSED because the
 *     operator's intent (single_only) conflicts with the rendered
 *     payload (multiple parts);
 *   - compute the fresh payload hash to persist on the row as
 *     operatorApprovedShapeHash;
 *   - decide whether a publish should be BLOCKED because the
 *     freshly-rendered hash no longer matches the approved one.
 *
 * Isolation
 * ---------
 * This file is Bluesky-only. The approval-time + publish-time call
 * sites both live behind a `platform === "bluesky"` guard so no
 * other platform is touched.
 *
 * The publish-time check uses the shared, deterministic
 * isApprovedPayloadStillCurrent helper from the platform-native
 * core. Platform-agnostic; no provider branching.
 */

import {
  computeProviderPayloadHash,
  isApprovedPayloadStillCurrent,
  parsePlatformNativeShape,
  serializePlatformNativeShape,
  type PlatformNativeShape,
  type ProviderPayloadPreview,
} from "../..";
import { blueskyAdapter } from "./index";
import type { AdapterCreative } from "../types";

// =====================================================================
// Approval-time: refuse + persist
// =====================================================================

export interface BlueskyApprovalCheckInput {
  /** Raw JSONB from weekly_plan_items.platform_publish_intent.
   *  `null` means legacy mode → caller skips this entire flow. */
  rawIntent: Record<string, unknown> | null;
  /** Current plan-item title (may be ignored by the adapter). */
  title: string | null;
  /** Current plan-item body. */
  body: string;
  /** Current attached creative, if any. */
  creative: AdapterCreative | null;
}

export interface BlueskyApprovalBlocker {
  code: "single_post_exceeds_budget" | string;
  message: string;
}

export type BlueskyApprovalCheckResult =
  | {
      kind: "legacy_no_enforcement";
      /** Caller writes nothing to platform_publish_intent. */
    }
  | {
      kind: "refuse";
      blockers: ReadonlyArray<BlueskyApprovalBlocker>;
    }
  | {
      kind: "bind";
      /** Serialized envelope (snake_case keys; ready for the DB
       *  column write). operatorApprovedShapeHash is set to the
       *  fresh payload hash. */
      serializedIntent: Record<string, unknown>;
      /** The fresh payload hash for telemetry / observability. */
      payloadHash: string;
      /** The preview the hash was computed from. Useful for the
       *  caller's response payload + tests. */
      preview: ProviderPayloadPreview;
    };

/**
 * Compute the approval-time decision for a Bluesky plan item.
 *
 *   - rawIntent === null               → legacy_no_enforcement
 *   - shape.threadMode === "single_only" AND preview produces
 *     more than one part               → refuse(single_post_exceeds_budget)
 *   - preview has any other blocker
 *     (e.g. creative_missing_alt_text) → refuse with that blocker
 *   - otherwise                        → bind(new hash)
 *
 * Pure. Async only because the hash is computed via Web Crypto.
 */
export async function decideBlueskyApprovalShape(
  input: BlueskyApprovalCheckInput,
): Promise<BlueskyApprovalCheckResult> {
  // Legacy rows: no operator intent → no binding, no enforcement.
  // Caller's approval flow continues unchanged for these rows.
  if (input.rawIntent === null) {
    return { kind: "legacy_no_enforcement" };
  }

  const shape = parsePlatformNativeShape(input.rawIntent, "bluesky");
  if (!shape) {
    // Malformed envelope on disk — treat as legacy so existing rows
    // are never wedged by parser drift. The compose modal's summary
    // surface already shows the "Legacy" badge in this case.
    return { kind: "legacy_no_enforcement" };
  }

  // Build a fresh preview from the SAME shape the row carries — this
  // is the canonical preview/publish parity contract.
  const preview = blueskyAdapter.buildPreview({
    title: input.title,
    body: input.body,
    identity: { displayName: null, handle: null, avatarUrl: null },
    creative: input.creative,
    shape,
  });

  // Refuse on any preview-side blocker. The adapter already produces
  // the spec'd `single_post_exceeds_budget` code for the thread
  // overflow case; we surface every blocker so callers don't bind to
  // a payload the publisher would refuse later.
  if (preview.blockers.length > 0) {
    return {
      kind: "refuse",
      blockers: preview.blockers.map((b) => ({
        code: b.code,
        message: b.message,
      })),
    };
  }

  // Compute the hash and serialize the new envelope.
  const payloadHash = await computeProviderPayloadHash(preview);
  const boundShape: PlatformNativeShape = {
    ...shape,
    operatorApprovedShapeHash: payloadHash,
  };
  return {
    kind: "bind",
    serializedIntent: serializePlatformNativeShape(boundShape),
    payloadHash,
    preview,
  };
}

// =====================================================================
// Publish-time: gate
// =====================================================================

export interface BlueskyPublishGateInput {
  /** Raw JSONB envelope from weekly_plan_items.platform_publish_intent. */
  rawIntent: Record<string, unknown> | null;
  /** Live body / title / creative the publisher is about to send. */
  title: string | null;
  body: string;
  creative: AdapterCreative | null;
}

export type BlueskyPublishGateDecision =
  | {
      kind: "proceed";
      /** When the row HAS an approved hash AND it matches, telemetry
       *  carries the hash so audit can trace it. */
      payloadHash: string | null;
    }
  | {
      kind: "block_stale";
      approvedHash: string;
      currentHash: string;
      reasonDetail: string;
    };

/**
 * Decide whether to allow the Bluesky publish to proceed.
 *
 *   - rawIntent === null                                  → proceed (legacy)
 *   - parsed shape has no operatorApprovedShapeHash       → proceed (legacy row
 *                                                            persisted by MCP
 *                                                            but never approved)
 *   - approved hash MATCHES freshly-computed hash         → proceed
 *   - mismatch                                            → block_stale
 *
 * Pure (no I/O); async only for Web Crypto.
 *
 * The caller MUST short-circuit on `block_stale` BEFORE any provider
 * call (uploadBlob, createRecord) — that's the whole point.
 */
export async function decideBlueskyPublishGate(
  input: BlueskyPublishGateInput,
): Promise<BlueskyPublishGateDecision> {
  if (input.rawIntent === null) {
    return { kind: "proceed", payloadHash: null };
  }
  const shape = parsePlatformNativeShape(input.rawIntent, "bluesky");
  if (!shape || !shape.operatorApprovedShapeHash) {
    return { kind: "proceed", payloadHash: null };
  }
  const preview = blueskyAdapter.buildPreview({
    title: input.title,
    body: input.body,
    identity: { displayName: null, handle: null, avatarUrl: null },
    creative: input.creative,
    shape,
  });
  const currentHash = await computeProviderPayloadHash(preview);
  const matches = await isApprovedPayloadStillCurrent(
    shape.operatorApprovedShapeHash,
    preview,
  );
  if (matches) {
    return { kind: "proceed", payloadHash: currentHash };
  }
  return {
    kind: "block_stale",
    approvedHash: shape.operatorApprovedShapeHash,
    currentHash,
    reasonDetail:
      "Bluesky: the operator-approved payload shape has drifted (body, title, creative, or intent changed after approval). Re-approve to bind the new shape.",
  };
}
