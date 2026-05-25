/**
 * Schedule firewall for the FounderComposeSheet.
 *
 * Three goals:
 *
 *   1. Body/title/creative autosaves CANNOT touch scheduled_at.
 *      The schedule has its own dedicated save path, and the only
 *      callers of that path are operator-driven (preset click,
 *      datetime-input change, explicit clear).
 *
 *   2. While the modal is open, the schedule snapshot taken at
 *      closed → open is frozen. Parent re-renders that pass a fresh
 *      `existingItem.scheduledAtIso` cannot mutate the operator's
 *      in-progress edit.
 *
 *   3. Every schedule write carries an explicit `reason`. The server
 *      rejects writes without a recognized reason; the client
 *      `console.warn`s if a reason is missing.
 *
 * This module is pure — no React, no DOM, no I/O. The compose sheet
 * is responsible for wiring its setters to the operator events and
 * for plumbing the saver function.
 */

import { datetimeLocalToIso } from "@/core/publishing/schedule-presets";

export type ScheduleSaveReason = "preset" | "input" | "clear";

export interface ScheduleState {
  /** Current value in the `<input type="datetime-local">`. */
  inputValue: string;
  /** Frozen ISO snapshot of what the row held at modal-open. */
  initialIso: string | null;
  /** True once the operator has touched the picker this session. */
  touched: boolean;
}

export function initialScheduleState(initialIso: string | null): ScheduleState {
  return {
    inputValue: initialIso ? isoToDatetimeLocal(initialIso) : "",
    initialIso,
    touched: false,
  };
}

/** Operator typed in the datetime input. */
export function touchByInput(
  state: ScheduleState,
  value: string,
): ScheduleState {
  return { ...state, inputValue: value, touched: true };
}

/** Operator clicked a preset chip; presetValue is already in
 * datetime-local shape. */
export function touchByPreset(
  state: ScheduleState,
  presetValue: string,
): ScheduleState {
  return { ...state, inputValue: presetValue, touched: true };
}

/** Operator explicitly cleared the schedule. */
export function touchByClear(state: ScheduleState): ScheduleState {
  return { ...state, inputValue: "", touched: true };
}

export interface ScheduleSaveRequest {
  itemId: string;
  /** Empty string means "clear schedule". Non-empty must be ISO. */
  isoOrEmpty: string;
  reason: ScheduleSaveReason;
}

/**
 * Produce the payload that will be POSTed to saveScheduleAction.
 * Returns null when the state shouldn't trigger a save:
 *
 *   - operator hasn't touched
 *   - no item id yet (compose sheet hasn't completed first save)
 *
 * Throws when the datetime-local value can't be parsed — the caller
 * should surface that as a user error.
 */
export function buildScheduleSavePayload(
  state: ScheduleState,
  itemId: string | null,
  reason: ScheduleSaveReason,
): ScheduleSaveRequest | null {
  if (!state.touched) return null;
  if (!itemId) return null;

  if (state.inputValue.trim().length === 0) {
    return { itemId, isoOrEmpty: "", reason };
  }
  const iso = datetimeLocalToIso(state.inputValue);
  return { itemId, isoOrEmpty: iso, reason };
}

/**
 * Defensive guard: a schedule save with no reason is a bug. Block
 * the write and log loudly.
 */
export function assertScheduleReason(
  reason: ScheduleSaveReason | undefined | null,
): asserts reason is ScheduleSaveReason {
  if (reason !== "preset" && reason !== "input" && reason !== "clear") {
    if (typeof console !== "undefined" && typeof console.warn === "function") {
      console.warn(
        "[compose-schedule-save] blocked schedule write — missing or invalid reason",
        { reason },
      );
    }
    throw new Error("Schedule write requires an explicit reason.");
  }
}

function isoToDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
