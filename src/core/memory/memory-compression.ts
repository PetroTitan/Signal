import type { HistoricalPattern, HistoricalPatternKind } from "@/types/memory";
import type { SupportedChannel } from "@/core/platform-connections/platform-capabilities";
import { HISTORICAL_PATTERN_SCHEMA_VERSION, HISTORICAL_PATTERN_LIMITS } from "@/types/memory";

export interface RawCompressionEvent {
  kind: HistoricalPatternKind;
  platform: SupportedChannel | "any";
  productId: string | null;
  signal: string;
  positive: boolean;
  observedAt: string;
}

interface BucketKey {
  signal: string;
  kind: HistoricalPatternKind;
  platform: string;
  productId: string;
}

function bucketKey(e: RawCompressionEvent): string {
  return `${e.kind}::${e.platform}::${e.productId ?? "any"}::${e.signal}`;
}

function clampPattern(text: string): string {
  if (text.length <= HISTORICAL_PATTERN_LIMITS.patternLengthMax) return text;
  return `${text.slice(0, HISTORICAL_PATTERN_LIMITS.patternLengthMax - 1).trim()}…`;
}

export function compressEventsToPatterns(
  events: RawCompressionEvent[],
  now: Date = new Date(),
): HistoricalPattern[] {
  const buckets = new Map<string, { key: BucketKey; events: RawCompressionEvent[] }>();
  for (const e of events) {
    const k = bucketKey(e);
    const existing = buckets.get(k);
    if (existing) {
      existing.events.push(e);
    } else {
      buckets.set(k, {
        key: {
          signal: e.signal,
          kind: e.kind,
          platform: e.platform,
          productId: e.productId ?? "any",
        },
        events: [e],
      });
    }
  }

  const patterns: HistoricalPattern[] = [];
  for (const [k, bucket] of buckets) {
    const positives = bucket.events.filter((x) => x.positive).length;
    const total = bucket.events.length;
    if (total === 0) continue;
    const confidence = positives / total;
    const lastSeen = bucket.events
      .map((x) => Date.parse(x.observedAt))
      .filter((t) => !Number.isNaN(t))
      .sort((a, b) => b - a)[0];
    const lastSeenIso = lastSeen
      ? new Date(lastSeen).toISOString()
      : now.toISOString();
    patterns.push({
      schemaVersion: HISTORICAL_PATTERN_SCHEMA_VERSION,
      id: `pat_${hashKey(k)}`,
      pattern: clampPattern(bucket.key.signal),
      kind: bucket.key.kind,
      platform: bucket.key.platform === "any"
        ? "any"
        : (bucket.key.platform as SupportedChannel),
      productId: bucket.key.productId === "any" ? null : bucket.key.productId,
      confidence: Number(confidence.toFixed(2)),
      supportingEvents: total,
      lastSeenAt: lastSeenIso,
      relevanceScore: Number((confidence * Math.min(1, total / 5)).toFixed(2)),
      active: true,
    });
  }

  return patterns.sort((a, b) => b.relevanceScore - a.relevanceScore);
}

function hashKey(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

export const COMPRESSION_RULES = [
  "One pattern object per (kind, platform, product, signal) bucket.",
  "Confidence is positives / total observations.",
  "RelevanceScore decays for low support counts.",
  "Patterns truncate at HISTORICAL_PATTERN_LIMITS.patternLengthMax characters.",
  "Patterns are recomputed periodically, never appended unbounded.",
] as const;
