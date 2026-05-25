/**
 * Pure helpers for the FounderComposeSheet's body autosave path.
 *
 * NOTE: Schedule is intentionally NOT part of this payload. The
 * schedule has its own dedicated save path
 * (`compose-schedule-save.ts`) so body/title/creative/platform
 * autosaves can never drift the scheduled timestamp. If you find
 * yourself reaching for a `scheduledAt` field here — stop. The
 * regression you're about to cause already happened once.
 */

export interface ComposeAutosaveDraft {
  itemId: string | null;
  title: string;
  body: string;
  platform: string;
  contentType: string;
  subreddit: string;
  accountId: string;
  productId: string;
  riskScore: string;
  notes: string;
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
}

export function composeAutosavePayload(
  draft: ComposeAutosaveDraft,
): AutosavePayload {
  return {
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
}

export function serializeAutosaveDraft(draft: ComposeAutosaveDraft): string {
  return JSON.stringify(composeAutosavePayload(draft));
}
