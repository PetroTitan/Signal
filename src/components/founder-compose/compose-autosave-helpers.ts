/**
 * Pure helpers extracted from FounderComposeSheet so the autosave
 * round-trip behavior is unit-testable without rendering the whole
 * modal.
 *
 * Two concerns live here:
 *
 *  - shouldResetDraft: should the modal reset its draft state on this
 *    render? Only on a closed → open transition.
 *
 *  - composeAutosavePayload: what gets serialized for the autosave
 *    diff. The schedule field is *deliberately* omitted until the
 *    operator has actually touched the picker — otherwise the
 *    server's UTC normalization round-trips through
 *    `toDatetimeLocalString` and shifts the value by the operator's
 *    UTC offset on every save, producing the schedule-drift loop.
 */

export interface ComposeAutosaveDraft {
  itemId: string | null;
  title: string;
  body: string;
  scheduledAt: string;
  platform: string;
  contentType: string;
  subreddit: string;
  accountId: string;
  productId: string;
  riskScore: string;
  notes: string;
  scheduledAtTouched: boolean;
}

export function shouldResetDraft(prevOpen: boolean, nextOpen: boolean): boolean {
  return nextOpen && !prevOpen;
}

export interface AutosavePayload {
  t: string;
  b: string;
  p: string;
  c: string;
  sr: string;
  a: string;
  pr: string;
  r: string;
  n: string;
  id: string | null;
  /** Present only when the operator has touched the schedule picker. */
  s?: string;
}

export function composeAutosavePayload(
  draft: ComposeAutosaveDraft,
): AutosavePayload {
  const payload: AutosavePayload = {
    t: draft.title,
    b: draft.body,
    p: draft.platform,
    c: draft.contentType,
    sr: draft.subreddit,
    a: draft.accountId,
    pr: draft.productId,
    r: draft.riskScore,
    n: draft.notes,
    id: draft.itemId,
  };
  if (draft.scheduledAtTouched) {
    payload.s = draft.scheduledAt;
  }
  return payload;
}

export function serializeAutosaveDraft(draft: ComposeAutosaveDraft): string {
  return JSON.stringify(composeAutosavePayload(draft));
}
