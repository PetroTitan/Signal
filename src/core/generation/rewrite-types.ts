/**
 * Phase F4.6 — editorial rewrite actions.
 *
 * The compose sheet exposes these as inline chips. Each action
 * maps to a deterministic system+user prompt in rewrite-builder.ts
 * and persists lightweight metadata after the provider responds.
 *
 * Keep the list short. The brief is explicit: "small calm inline
 * chips, not dropdown forests".
 */

export type RewriteAction =
  | "rewrite"
  | "shorter"
  | "more_technical"
  | "more_founder"
  | "less_promotional"
  | "to_bluesky_thread"
  | "to_devto_article"
  | "improve_headline";

export const REWRITE_ACTION_LABELS: Record<RewriteAction, string> = {
  rewrite: "Rewrite",
  shorter: "Shorter",
  more_technical: "More technical",
  more_founder: "More founder-like",
  less_promotional: "Less promotional",
  to_bluesky_thread: "Adapt for Bluesky",
  to_devto_article: "Adapt for dev.to",
  improve_headline: "Improve headline",
};

export const REWRITE_ACTIONS: ReadonlyArray<RewriteAction> = [
  "rewrite",
  "shorter",
  "more_technical",
  "more_founder",
  "less_promotional",
  "to_bluesky_thread",
  "to_devto_article",
  "improve_headline",
];

export function isRewriteAction(value: string): value is RewriteAction {
  return (REWRITE_ACTIONS as readonly string[]).includes(value);
}

export interface RewriteInput {
  itemId: string;
  action: RewriteAction;
}

export type RewriteStatus =
  | "rewritten"
  | "provider_unavailable"
  | "provider_refused"
  | "no_body"
  | "no_change";
