/**
 * Phase F6.0 — provider payload hashing.
 *
 * Deterministic sha256 over the canonicalized ProviderPayloadPreview.
 * This is the value the operator's approval binds to. Publishers that
 * enforce shape-binding compare the freshly-rendered hash against the
 * stored `operatorApprovedShapeHash`; mismatch → block.
 *
 * Universal runtime
 * -----------------
 * Uses the Web Crypto API via `globalThis.crypto.subtle.digest`. The
 * same API is implemented natively in:
 *   - Node ≥16 (server actions, server components, scheduler tick)
 *   - Edge runtime (Next.js middleware, API route handlers)
 *   - All modern browsers (client components, including the compose-
 *     modal summary that renders the live shape)
 *
 * The single async API replaces the previous sync `node:crypto` path
 * so the SAME function produces the SAME hash on every surface — the
 * preview-publish parity contract holds across the wire.
 *
 * Canonicalization rules
 * ----------------------
 *   - Object keys are emitted in a fixed, sorted order.
 *   - Arrays are emitted in source order (the part order IS load-
 *     bearing — swapping part 1 and 2 is a different post).
 *   - Numeric fields are emitted as JSON numbers; null stays null.
 *   - `warnings` are NOT hashed (advisory only; not part of the
 *     publish contract).
 *   - `blockers` ARE hashed (a payload with a blocker is a different
 *     payload from the same one without).
 *
 * Pure module. No I/O. No randomness. No clock.
 */

import type {
  ProviderPayloadBlocker,
  ProviderPayloadPart,
  ProviderPayloadPreview,
} from "./publishing-intent";

const HASH_VERSION = 1;

/**
 * Compute the hash for a payload.
 *
 * Format: `"sha256:v1:<hex>"`. The version prefix lets us evolve the
 * canonical form later without silently invalidating existing
 * approvals (a v1 stored hash compared against a v2 freshly-rendered
 * hash will mismatch — which is the right answer; rebind approval).
 */
export async function computeProviderPayloadHash(
  preview: ProviderPayloadPreview,
): Promise<string> {
  const canonical = canonicalize(preview);
  const json = JSON.stringify(canonical);
  const hex = await sha256Hex(json);
  return `sha256:v${HASH_VERSION}:${hex}`;
}

/**
 * True when the approved hash matches the current preview's
 * freshly-rendered hash. False when:
 *   - approved hash is null (no approval bound yet);
 *   - approved hash format is wrong;
 *   - canonical payload has drifted.
 *
 * Adapters that enforce shape-binding call this at publish time.
 */
export async function isApprovedPayloadStillCurrent(
  approvedHash: string | null,
  currentPreview: ProviderPayloadPreview,
): Promise<boolean> {
  if (!approvedHash) return false;
  const currentHash = await computeProviderPayloadHash(currentPreview);
  return approvedHash === currentHash;
}

// =====================================================================
// Internal — Web Crypto sha256 (works in Node + Edge + browser)
// =====================================================================

async function sha256Hex(input: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    // Defensive: fail loud rather than silently degrading. Every
    // supported runtime (Node ≥16, Edge, modern browsers) has
    // globalThis.crypto.subtle. If we land somewhere it's missing,
    // the hash binding contract is compromised and we want to know.
    throw new Error(
      "computeProviderPayloadHash: globalThis.crypto.subtle is unavailable in this runtime.",
    );
  }
  const data = new TextEncoder().encode(input);
  const buffer = await subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// =====================================================================
// Internal — canonicalization
// =====================================================================

interface CanonicalPayload {
  platform: string;
  intent: string;
  format: string;
  parts: ReadonlyArray<CanonicalPart>;
  blockers: ReadonlyArray<CanonicalBlocker>;
  /** Sorted key/value pairs from preview.routing — adapter-supplied
   *  provider-native metadata (subreddit, link URL, etc.). Always
   *  emitted as a JSON object with keys in alphabetical order so the
   *  hash is order-stable. */
  routing: Readonly<Record<string, string | null>>;
}

interface CanonicalPart {
  index: number;
  text: string;
  media: {
    attached: boolean;
    target: string;
    altText: string | null;
  };
}

interface CanonicalBlocker {
  code: string;
  message: string;
}

function canonicalize(preview: ProviderPayloadPreview): CanonicalPayload {
  return {
    platform: preview.platform,
    intent: preview.intent,
    format: preview.format,
    parts: preview.parts.map(canonicalizePart),
    blockers: preview.blockers.map(canonicalizeBlocker),
    routing: canonicalizeRouting(preview.routing),
  };
}

function canonicalizeRouting(
  routing: Readonly<Record<string, string | null>> | undefined,
): Readonly<Record<string, string | null>> {
  if (!routing) return {};
  const sorted: Record<string, string | null> = {};
  for (const key of Object.keys(routing).sort()) {
    sorted[key] = routing[key];
  }
  return sorted;
}

function canonicalizePart(p: ProviderPayloadPart): CanonicalPart {
  return {
    index: p.index,
    text: p.text,
    media: {
      attached: p.media.attached,
      target: p.media.target,
      altText: p.media.altText,
    },
  };
}

function canonicalizeBlocker(b: ProviderPayloadBlocker): CanonicalBlocker {
  return { code: b.code, message: b.message };
}
