/**
 * Confidence-tagged field used by every MCP extraction contract.
 * Confidence is a 0..1 float; the UI renders <0.6 as needs-review.
 */
export interface ConfidentField<T> {
  value: T | null;
  /** 0 = no signal, 1 = certain. */
  confidence: number;
}

export const LOW_CONFIDENCE_THRESHOLD = 0.6;

export function field<T>(value: T | null, confidence: number): ConfidentField<T> {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(confidence) ? confidence : 0));
  return { value, confidence: Number(clamped.toFixed(2)) };
}

export function needsReview<T>(f: ConfidentField<T>): boolean {
  if (f.value === null) return true;
  return f.confidence < LOW_CONFIDENCE_THRESHOLD;
}

/**
 * Snapshot of "how good was this extraction overall" for the UI to
 * summarize at a glance.
 */
export interface ExtractionQuality {
  /** Number of fields the extractor attempted. */
  fieldsAttempted: number;
  /** Number of fields with value !== null. */
  fieldsExtracted: number;
  /** Mean confidence across non-null fields, or null if none. */
  meanConfidence: number | null;
  /** Field names below the low-confidence threshold (or null). */
  lowConfidenceFields: string[];
}

export function summarizeExtraction(
  fields: Record<string, ConfidentField<unknown>>,
): ExtractionQuality {
  const names = Object.keys(fields);
  const extracted = names.filter((n) => fields[n].value !== null);
  const confidences = extracted.map((n) => fields[n].confidence);
  const meanConfidence =
    confidences.length === 0
      ? null
      : Number(
          (confidences.reduce((s, c) => s + c, 0) / confidences.length).toFixed(2),
        );
  const lowConfidenceFields = names.filter((n) => needsReview(fields[n]));
  return {
    fieldsAttempted: names.length,
    fieldsExtracted: extracted.length,
    meanConfidence,
    lowConfidenceFields,
  };
}
