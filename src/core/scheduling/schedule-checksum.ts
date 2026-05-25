/**
 * Schedule checksum — opaque fingerprint that tracks a (itemId,
 * normalized-iso, timezone-offset, source) tuple across the
 * client → serialization → server → DB → hydration boundaries.
 *
 * The checksum is NOT a security primitive. It's a drift detector.
 * If the value changes between two points that should be equivalent,
 * something silently mutated the schedule and the system should
 * either reject the write or surface a calm warning.
 *
 * Implementation: FNV-1a 32-bit hash over a canonical string. Pure
 * JS, sync, no Node-only APIs, deterministic, edge-safe, dependency
 * free.
 */

import type { ScheduleSource } from "@/core/observability/schedule-events";

export interface ScheduleChecksumInput {
  itemId: string | null;
  /** Fully-qualified UTC ISO string OR null when the row is unscheduled. */
  iso: string | null;
  /** IANA timezone name OR null. Defaults to "UTC" if missing for
   *  hashing purposes, so two callers in the same situation produce
   *  the same checksum. */
  timezone: string | null;
  source: ScheduleSource | null;
}

const NULL_ISO_TOKEN = "_null_iso";
const NULL_TZ_TOKEN = "UTC";
const NULL_ITEM_TOKEN = "_null_item";
const NULL_SOURCE_TOKEN = "_null_source";

/**
 * Compute a stable, opaque 8-char checksum for a schedule tuple.
 *
 * Properties:
 *   - same input → same output across processes
 *   - small changes → very different output
 *   - null fields participate explicitly (no JS quirks)
 *   - ISO normalized via Date round-trip so equivalent timestamps
 *     written different ways produce the same checksum
 */
export function scheduleChecksum(input: ScheduleChecksumInput): string {
  const itemId = input.itemId ?? NULL_ITEM_TOKEN;
  const iso = input.iso ? normalizeIso(input.iso) : NULL_ISO_TOKEN;
  const timezone = input.timezone ?? NULL_TZ_TOKEN;
  const source = input.source ?? NULL_SOURCE_TOKEN;
  const canonical = `${itemId}|${iso}|${timezone}|${source}`;
  return fnv1a32(canonical);
}

/**
 * Compare two checksums. Returns:
 *   - "match" when equal
 *   - "drift" when they differ
 *
 * Stable across processes — no clock dependence.
 */
export function compareScheduleChecksums(
  before: string,
  after: string,
): "match" | "drift" {
  return before === after ? "match" : "drift";
}

/**
 * Drift detector — compares two ISO timestamps. Returns the absolute
 * delta in milliseconds. Use to bound acceptable jitter (e.g., a
 * server normalization that adds milliseconds is < 1000ms drift; a
 * UTC-offset shift is hours).
 */
export function detectIsoDrift(beforeIso: string, afterIso: string): number {
  const a = Date.parse(beforeIso);
  const b = Date.parse(afterIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.POSITIVE_INFINITY;
  return Math.abs(b - a);
}

export interface MutationAssertionResult {
  ok: boolean;
  /** When !ok, the human-readable reason. */
  reason?: string;
  /** Computed checksums for both sides, for observability emission. */
  beforeChecksum: string;
  afterChecksum: string;
}

/**
 * Assert that a schedule has NOT been mutated between two points.
 * Returns a structured result so the caller can:
 *   - reject the write
 *   - preserve original schedule
 *   - emit observability event
 *   - surface calm dev warning
 *
 * Never throws — callers decide how to respond.
 */
export function assertScheduleUnchanged(
  before: ScheduleChecksumInput,
  after: ScheduleChecksumInput,
): MutationAssertionResult {
  const beforeChecksum = scheduleChecksum(before);
  const afterChecksum = scheduleChecksum(after);
  if (beforeChecksum === afterChecksum) {
    return { ok: true, beforeChecksum, afterChecksum };
  }
  // Try to produce a useful reason without leaking content.
  const itemDiff =
    (before.itemId ?? "") !== (after.itemId ?? "") ? "item" : null;
  const isoDiff =
    normalizeNullable(before.iso) !== normalizeNullable(after.iso) ? "iso" : null;
  const tzDiff =
    (before.timezone ?? "") !== (after.timezone ?? "") ? "timezone" : null;
  const srcDiff =
    (before.source ?? "") !== (after.source ?? "") ? "source" : null;
  const diffs = [itemDiff, isoDiff, tzDiff, srcDiff].filter(Boolean);
  return {
    ok: false,
    reason: `schedule mutation detected (${diffs.join(", ") || "unknown"})`,
    beforeChecksum,
    afterChecksum,
  };
}

// =====================================================================
// Internals
// =====================================================================

function normalizeIso(iso: string): string {
  // ISO strings can be written equivalently many ways. Round-trip
  // through Date to a single canonical form.
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso.trim();
  return new Date(t).toISOString();
}

function normalizeNullable(iso: string | null): string {
  return iso ? normalizeIso(iso) : "";
}

/**
 * FNV-1a 32-bit hash. Returns 8-char lowercase hex. Stable across
 * runtimes — no crypto, no async.
 */
function fnv1a32(input: string): string {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // 32-bit multiply by FNV prime (0x01000193)
    hash = Math.imul(hash, 0x01000193);
  }
  // Convert to unsigned, render as 8-char lowercase hex.
  return (hash >>> 0).toString(16).padStart(8, "0");
}
