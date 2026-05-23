"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Debounced autosave hook.
 *
 * Pure-state: caller passes a value (typically the form state) and a
 * `save` function that returns `{ ok: boolean }`. The hook fires
 * `save` after the configured idle delay, surfacing four states for
 * the UI to render:
 *
 *   "idle"        — clean / no changes since last save
 *   "dirty"       — operator typed; debounce timer running
 *   "saving"      — `save()` in flight
 *   "error"       — last save returned !ok
 *
 * The hook does NOT decide what counts as "empty" — the caller's
 * `enabled` predicate gates whether the timer arms at all.
 */

export type AutosaveStatus = "idle" | "dirty" | "saving" | "error";

export interface UseAutosaveOptions<T> {
  /** Stable serialization of the value. The hook diffs this string
   *  against the last-saved version to know if a save is needed. */
  serialize: (value: T) => string;
  /** Should we attempt to save at all? Use this to suppress empty
   *  drafts. Defaults to always-on. */
  enabled?: (value: T) => boolean;
  /** Debounce window in ms. Defaults to 1500. */
  delayMs?: number;
  /** Save function. Should be idempotent — autosave may fire twice
   *  in quick succession if the operator pauses and resumes typing. */
  save: (value: T) => Promise<{ ok: boolean; error?: string }>;
}

export interface UseAutosaveReturn<T> {
  status: AutosaveStatus;
  /** Most recent save error, if any. Cleared when status returns to
   *  idle/dirty. */
  errorMessage: string | null;
  /** Force a flush now (e.g. before closing the sheet). */
  flushNow: () => Promise<void>;
  /**
   * Mark a value as already-saved externally (e.g. by an AI rewrite
   * server action that persisted the change). Updates the hook's
   * internal high-water mark so the next debounce cycle doesn't
   * fire a redundant save. Cancels any in-flight debounce.
   */
  markSaved: (value: T) => void;
}

export function useAutosave<T>(
  value: T,
  options: UseAutosaveOptions<T>,
): UseAutosaveReturn<T> {
  const { serialize, save } = options;
  const enabled = options.enabled ?? (() => true);
  const delayMs = options.delayMs ?? 1500;

  const [status, setStatus] = useState<AutosaveStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const lastSavedRef = useRef<string>(serialize(value));
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const valueRef = useRef<T>(value);
  valueRef.current = value;

  const runSave = async (val: T) => {
    if (!enabled(val)) return;
    const ser = serialize(val);
    if (ser === lastSavedRef.current) {
      setStatus("idle");
      return;
    }
    setStatus("saving");
    try {
      const result = await save(val);
      if (result.ok) {
        lastSavedRef.current = ser;
        setStatus("idle");
        setErrorMessage(null);
      } else {
        setStatus("error");
        setErrorMessage(result.error ?? "Could not save.");
      }
    } catch (err) {
      setStatus("error");
      setErrorMessage(err instanceof Error ? err.message : "Could not save.");
    }
  };

  useEffect(() => {
    const ser = serialize(value);
    if (ser === lastSavedRef.current) {
      setStatus("idle");
      return;
    }
    if (!enabled(value)) {
      // Not eligible — leave clean.
      return;
    }
    setStatus("dirty");
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => runSave(value), delayMs);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serialize(value)]);

  const flushNow = async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    await runSave(valueRef.current);
  };

  const markSaved = (val: T) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    lastSavedRef.current = serialize(val);
    setStatus("idle");
    setErrorMessage(null);
  };

  return { status, errorMessage, flushNow, markSaved };
}

export function autosaveLabel(status: AutosaveStatus): string {
  switch (status) {
    case "idle":
      return "Saved";
    case "dirty":
      return "Saving in a moment…";
    case "saving":
      return "Saving…";
    case "error":
      return "Save failed — your work is still here";
  }
}
