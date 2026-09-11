/**
 * Canonical presentation of a Bluesky handle.
 *
 * THE DEFECT THIS FIXES
 * ---------------------
 * Production rendered `@@webmasterid.bsky.social`. The cause: the UI
 * wrote `@{handle}` at every call site, and a handle can already carry
 * a leading `@` because `growth_accounts.handle` stores whatever the
 * operator typed when they created the identity. Concatenating a
 * decorative `@` onto a value that may already have one doubles it.
 *
 * `normalizeBlueskyHandle` in `identity-verifiers/bluesky-resolve.ts`
 * would not have fixed it either: it strips exactly ONE leading `@`
 * (`replace(/^@/, "")`), so `@@name` normalizes to `@name`, which is
 * still wrong. It also lowercases, which is correct for an API call and
 * wrong for display.
 *
 * So this is a separate, display-only concern with its own function.
 *
 * WHAT IT IS NOT
 * --------------
 * It does not touch stored data. Nothing here writes a row, and no
 * caller is expected to persist its output — the fix is at the render
 * boundary precisely so that stored handles are left exactly as the
 * operator and the provider wrote them.
 *
 * It is also not identity. DIDs remain authoritative everywhere; this
 * produces a label for a human to read and nothing else. There is no
 * function in this file that returns something safe to key on.
 *
 * Pure, no I/O, no `server-only` — the client components import it.
 */

/** Shown when a handle is missing or is nothing but punctuation. */
export const HANDLE_UNAVAILABLE = "handle unavailable";

/**
 * Strip every leading `@` and surrounding whitespace.
 *
 * Returns null when nothing usable remains, so a caller cannot
 * accidentally render a bare `@` or an empty string.
 *
 * Note `@+` rather than `@?`: the whole point is that the input may
 * carry any number of them, including from a value that has already
 * been through a one-`@` stripper.
 */
export function bareHandle(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const stripped = raw.trim().replace(/^@+/, "").trim();
  return stripped.length === 0 ? null : stripped;
}

/**
 * Render a handle with exactly one leading `@`.
 *
 * Idempotent: `formatHandle(formatHandle(x)) === formatHandle(x)`, which
 * matters because these values get passed through props, notices and
 * activity titles where a second formatting pass is easy to introduce
 * and impossible to see.
 *
 * Casing is preserved. A handle is case-insensitive on Bluesky, and
 * lowercasing here would make the UI disagree with the value the
 * operator typed for no benefit.
 */
export function formatHandle(
  raw: string | null | undefined,
  fallback: string = HANDLE_UNAVAILABLE,
): string {
  const bare = bareHandle(raw);
  return bare === null ? fallback : `@${bare}`;
}

/**
 * Label for an identity in a picker: the handle when there is one,
 * otherwise the display name, otherwise the id.
 *
 * The id fallback is deliberate — an identity with neither a handle nor
 * a name still has to be selectable, and a blank `<option>` is worse
 * than an opaque one.
 */
export function formatIdentityLabel(identity: {
  handle?: string | null;
  displayName?: string | null;
  id: string;
}): string {
  const bare = bareHandle(identity.handle);
  if (bare !== null) return `@${bare}`;
  const name = identity.displayName?.trim();
  if (name) return name;
  return identity.id;
}

/**
 * Label for a candidate or target row: the display name when there is
 * one, falling back to the formatted handle, then to a neutral noun.
 *
 * Never falls back to the DID. A DID is 32 characters of base32 and
 * reads as noise in a heading; it is rendered separately, on its own
 * line, where it is identifiable as an identifier.
 */
export function formatAccountName(account: {
  displayName?: string | null;
  handle?: string | null;
}): string {
  const name = account.displayName?.trim();
  if (name) return name;
  const bare = bareHandle(account.handle);
  if (bare !== null) return bare;
  return "Bluesky account";
}
