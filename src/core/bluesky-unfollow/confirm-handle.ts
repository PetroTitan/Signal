/**
 * The ONE way a typed handle is compared with the handle an action will
 * be performed as.
 *
 * THE DEFECT THIS FIXES
 * ---------------------
 * The activation dialog asked the operator to type back the handle it
 * displayed — `@webmasterid.bsky.social` — and compared
 * `typed.replace(/^@/, "")` with the displayed value as stored. The
 * stored value carries its own `@` (`growth_accounts.handle` keeps what
 * the operator typed when they created the identity), so the only
 * input that satisfied the comparison was `@@webmasterid.bsky.social`.
 * The server compared against the SESSION's handle, which has no `@`,
 * so it accepted the single-`@` form the dialog refused: two sides,
 * two normalisations, and the instruction on screen was the one input
 * that could not pass.
 *
 * Both sides now go through `canonicalConfirmationHandle` and compare
 * with `confirmationHandleMatches`. There is no other comparison.
 *
 * WHAT IS ACCEPTED
 * ----------------
 * Zero or one leading `@`; surrounding whitespace; any letter case.
 * That is the whole list. In particular the canonical form REFUSES:
 *
 *   - a second `@` (`@@name` is not a handle, and it was the bug);
 *   - whitespace anywhere inside the handle;
 *   - any character outside printable ASCII — a Cyrillic `а` or a
 *     full-width `ｗ` is a different string, however it looks. Bluesky
 *     handles are DNS names; an internationalised one is expressed in
 *     punycode (`xn--…`), which IS ASCII and IS accepted as typed;
 *   - anything that is not a syntactically valid handle (at least two
 *     labels, each `[a-z0-9]` with interior hyphens), so a substring
 *     or a prefix of the real handle cannot match by accident.
 *
 * Case is folded ONLY after the non-ASCII check, so `toLowerCase` can
 * never turn a lookalike into the real thing.
 *
 * Pure, no I/O, no `server-only`: the client dialog imports it.
 */

const HANDLE_LABEL = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
const HANDLE = new RegExp(`^${HANDLE_LABEL}(?:\\.${HANDLE_LABEL})+$`);

/** Printable ASCII only — no control characters, no non-ASCII. */
const PRINTABLE_ASCII = /^[\x21-\x7e]*$/;

/**
 * Canonical form of a handle, or null when the input is not a handle.
 *
 * Idempotent: `canonicalConfirmationHandle(canonicalConfirmationHandle(x))`
 * equals `canonicalConfirmationHandle(x)`.
 */
export function canonicalConfirmationHandle(
  raw: string | null | undefined,
): string | null {
  if (raw === null || raw === undefined) return null;
  // Surrounding whitespace only. Interior whitespace survives to the
  // ASCII check below and is rejected there.
  const trimmed = raw.replace(/^\s+|\s+$/g, "");
  // Exactly ONE optional `@`. A second one is left in place and fails
  // the grammar.
  const withoutAt = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  if (withoutAt.length === 0) return null;
  if (!PRINTABLE_ASCII.test(withoutAt)) return null;
  const lower = withoutAt.toLowerCase();
  return HANDLE.test(lower) ? lower : null;
}

/**
 * True only when both values canonicalise to the SAME valid handle.
 *
 * An expected handle that is not itself valid never matches anything:
 * a dialog fed a broken value must stay disabled rather than accept
 * whatever happens to equal the broken value.
 */
export function confirmationHandleMatches(
  typed: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  const a = canonicalConfirmationHandle(typed);
  const b = canonicalConfirmationHandle(expected);
  return a !== null && b !== null && a === b;
}

/**
 * The handle as the dialog shows it and asks for it: one `@`, the
 * canonical form. Null when there is nothing valid to show — the
 * dialog must then refuse to open rather than ask for "@".
 */
export function displayConfirmationHandle(
  raw: string | null | undefined,
): string | null {
  const canonical = canonicalConfirmationHandle(raw);
  return canonical === null ? null : `@${canonical}`;
}
