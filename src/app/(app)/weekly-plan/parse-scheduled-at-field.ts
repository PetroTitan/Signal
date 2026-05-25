/**
 * Pure parsing helper for the `scheduled_at` form field in the
 * compose sheet's upsert path. Extracted so the three-state behavior
 * is unit-testable without standing up the whole server action.
 *
 *   field absent         → `{ kind: "skip" }`
 *   field empty string   → `{ kind: "clear" }`
 *   field with TZ suffix → `{ kind: "set", iso }`
 *   field without TZ     → `{ kind: "error", message }`
 *
 * Why we reject bare datetime-local strings: `new Date("2026-05-20T16:01")`
 * interprets the value in the runtime's local zone, which is UTC on
 * Vercel. Round-tripping through that path was the root cause of the
 * autosave schedule drift — the timestamp shifted by the operator's
 * UTC offset every save. The client now uses `datetimeLocalToIso`
 * before submitting, so all values arriving here should already be
 * fully-qualified.
 */

export type ParsedScheduledAt =
  | { kind: "skip" }
  | { kind: "clear" }
  | { kind: "set"; iso: string }
  | { kind: "error"; message: string };

export function parseScheduledAtField(
  formData: Pick<FormData, "has" | "get">,
): ParsedScheduledAt {
  if (!formData.has("scheduled_at")) return { kind: "skip" };
  const raw = String(formData.get("scheduled_at") ?? "").trim();
  if (raw.length === 0) return { kind: "clear" };
  const hasTz = /Z$|[+-]\d{2}:?\d{2}$/.test(raw);
  if (!hasTz) {
    return {
      kind: "error",
      message:
        "Schedule must be a fully-qualified timestamp (with timezone).",
    };
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    return { kind: "error", message: "Could not parse the scheduled time." };
  }
  return { kind: "set", iso: d.toISOString() };
}
