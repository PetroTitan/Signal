import {
  REAL_EMPTY_COPY,
  type RealEmptyKey,
} from "./data-mode";

export interface RealEmptyState {
  key: RealEmptyKey;
  title: string;
  hint: string;
  cta: { href: string; label: string };
}

/**
 * Centralized constructor so every "not connected yet" state across the app
 * speaks the same language and points at the right CTA. Returning a typed
 * object keeps the UI layer free of stringly-typed copy.
 */
export function realEmpty(key: RealEmptyKey): RealEmptyState {
  const copy = REAL_EMPTY_COPY[key];
  return { key, title: copy.title, hint: copy.hint, cta: copy.cta };
}
