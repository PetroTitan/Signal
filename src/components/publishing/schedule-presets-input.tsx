"use client";

import { useState } from "react";
import {
  SCHEDULE_PRESETS,
  toDatetimeLocalString,
} from "@/core/publishing/schedule-presets";

/**
 * Founder-friendly scheduling input.
 *
 * Default view is a row of preset chips ("Today evening",
 * "Tomorrow morning", "Friday morning", "Next Monday") + a "Custom…"
 * toggle that reveals the underlying datetime-local input. The
 * hidden `name="scheduled_at"` field always carries the resolved
 * value so the form submit shape stays compatible with
 * updatePlanItemAction.
 */

export interface SchedulePresetsInputProps {
  /** Form field name. Defaults to "scheduled_at" so it slots into
   *  the existing updatePlanItemAction. */
  name?: string;
  /** ISO timestamp to seed the input. */
  defaultValueIso?: string | null;
  /** Workspace timezone label, e.g. "Europe/Prague". Shown as a
   *  subtle hint so the operator knows what timezone they're
   *  setting. */
  timezoneLabel?: string | null;
}

export function SchedulePresetsInput(props: SchedulePresetsInputProps) {
  const name = props.name ?? "scheduled_at";
  const [value, setValue] = useState<string>(
    props.defaultValueIso
      ? toLocalInputValue(props.defaultValueIso)
      : "",
  );
  const [showCustom, setShowCustom] = useState<boolean>(
    Boolean(props.defaultValueIso),
  );
  const [active, setActive] = useState<string | null>(null);

  function applyPreset(presetId: string) {
    const preset = SCHEDULE_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    const resolved = preset.resolve(new Date());
    setValue(toDatetimeLocalString(resolved));
    setActive(presetId);
    setShowCustom(false);
  }

  function clear() {
    setValue("");
    setActive(null);
    setShowCustom(false);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {SCHEDULE_PRESETS.map((p) => {
          const isActive = active === p.id;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => applyPreset(p.id)}
              className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${
                isActive
                  ? "bg-signal-50 border-signal-200 text-signal-800"
                  : "bg-white border-ink-200 text-ink-700 hover:bg-ink-50"
              }`}
              title={p.hint(new Date())}
            >
              {p.label}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setShowCustom((v) => !v)}
          className={`text-[11px] px-2.5 py-1 rounded-full border ${
            showCustom
              ? "bg-ink-100 border-ink-300 text-ink-800"
              : "bg-white border-ink-200 text-ink-700 hover:bg-ink-50"
          }`}
        >
          Custom…
        </button>
        {value ? (
          <button
            type="button"
            onClick={clear}
            className="text-[11px] px-2.5 py-1 text-ink-500 hover:text-ink-800"
          >
            Clear
          </button>
        ) : null}
      </div>

      {showCustom ? (
        <input
          type="datetime-local"
          name={name}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setActive(null);
          }}
          className="input w-full text-sm"
        />
      ) : (
        <input type="hidden" name={name} value={value} />
      )}

      <div className="text-[11px] text-ink-500 leading-relaxed">
        {value ? (
          <>
            Will publish at{" "}
            <span className="font-mono text-ink-700">
              {prettifyLocal(value)}
            </span>
            {props.timezoneLabel ? (
              <> ({props.timezoneLabel})</>
            ) : (
              <> (browser local time)</>
            )}
            .
          </>
        ) : (
          <>
            No schedule set yet. Pick a preset above or click{" "}
            <span className="font-mono">Custom…</span>.
          </>
        )}
      </div>
    </div>
  );
}

function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return toDatetimeLocalString(d);
}

function prettifyLocal(localInputValue: string): string {
  // localInputValue shape: YYYY-MM-DDTHH:MM
  const d = new Date(localInputValue);
  if (Number.isNaN(d.getTime())) return localInputValue;
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
