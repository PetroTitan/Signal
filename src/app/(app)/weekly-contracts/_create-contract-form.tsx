"use client";

import { useEffect, useRef, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import {
  createContractAction,
  type CreateContractResult,
} from "./_actions";

const initial: CreateContractResult = { ok: false, error: "" };

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const PLATFORM_LABELS: Record<string, string> = {
  reddit: "Reddit",
  devto: "dev.to",
  hashnode: "Hashnode",
  bluesky: "Bluesky",
  x: "X",
  linkedin: "LinkedIn",
};

function localTimezoneLabel(): string {
  if (typeof Intl === "undefined") return "your local time";
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "your local time";
  }
}

interface CreateContractFormProps {
  defaultWeekStart: string;
  defaultWeekEnd: string;
  products: { id: string; name: string }[];
  accounts: { id: string; displayName: string; platform: string }[];
  platforms: string[];
  actionTypes: { value: string; label: string }[];
}

interface WindowDraft {
  id: number;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

export function CreateContractForm({
  defaultWeekStart,
  defaultWeekEnd,
  products,
  accounts,
  platforms,
  actionTypes,
}: CreateContractFormProps) {
  const [state, formAction] = useFormState(createContractAction, initial);
  const formRef = useRef<HTMLFormElement>(null);

  const [windows, setWindows] = useState<WindowDraft[]>([
    { id: 1, dayOfWeek: 1, startTime: "09:00", endTime: "12:00" },
    { id: 2, dayOfWeek: 3, startTime: "09:00", endTime: "12:00" },
  ]);
  const nextWindowId = useRef(3);

  useEffect(() => {
    if (state?.ok) {
      formRef.current?.reset();
      setWindows([
        { id: 1, dayOfWeek: 1, startTime: "09:00", endTime: "12:00" },
        { id: 2, dayOfWeek: 3, startTime: "09:00", endTime: "12:00" },
      ]);
      nextWindowId.current = 3;
    }
  }, [state]);

  const safe = state ?? initial;

  const tz = localTimezoneLabel();
  return (
    <section className="rounded-2xl border border-ink-200 bg-white p-5">
      <h2 className="text-sm font-semibold text-ink-900">
        Plan a new publishing week
      </h2>
      <p className="text-xs text-ink-600 mt-1 leading-relaxed">
        Drafts aren&apos;t active. After review, you submit for approval,
        type the confirmation phrase, and activate the scope.
      </p>

      <form
        ref={formRef}
        action={formAction}
        className="mt-4 space-y-4 text-sm"
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="block md:col-span-2">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
              Title
            </div>
            <input
              type="text"
              name="title"
              defaultValue={`Week of ${defaultWeekStart}`}
              required
              className="input w-full"
            />
          </label>

          <label className="block">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
              Publishing week starts
            </div>
            <input
              type="date"
              name="week_start"
              defaultValue={defaultWeekStart}
              required
              className="input w-full"
            />
          </label>

          <label className="block">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
              Publishing week ends
            </div>
            <input
              type="date"
              name="week_end"
              defaultValue={defaultWeekEnd}
              required
              className="input w-full"
            />
          </label>

          <label className="block">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
              Max risk
            </div>
            <select
              name="max_risk_level"
              defaultValue="medium"
              className="input w-full"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>

          <label className="block">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
              Most posts this week
            </div>
            <input
              type="number"
              name="max_actions_total"
              min={0}
              placeholder="No limit"
              className="input w-full"
            />
          </label>

          <label className="block">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
              Most posts in one day
            </div>
            <input
              type="number"
              name="max_actions_per_day"
              min={0}
              placeholder="No limit"
              className="input w-full"
            />
          </label>

          <label className="block">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
              Most per platform per day
            </div>
            <input
              type="number"
              name="max_actions_per_platform_per_day"
              min={0}
              placeholder="No limit"
              className="input w-full"
            />
          </label>
        </div>

        <fieldset>
          <legend className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
            Accounts in scope
          </legend>
          <div className="mt-1 grid grid-cols-1 md:grid-cols-2 gap-1 max-h-40 overflow-y-auto border border-ink-100 rounded p-2">
            {accounts.length === 0 ? (
              <div className="text-xs text-ink-500">
                No accounts yet. Add growth accounts first.
              </div>
            ) : (
              accounts.map((a) => (
                <label key={a.id} className="flex items-center gap-2 text-xs text-ink-700">
                  <input type="checkbox" name="account_ids" value={a.id} />
                  <span>
                    {a.displayName}{" "}
                    <span className="text-ink-500">({a.platform})</span>
                  </span>
                </label>
              ))
            )}
          </div>
        </fieldset>

        <fieldset>
          <legend className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
            Products in scope
          </legend>
          <div className="mt-1 grid grid-cols-1 md:grid-cols-2 gap-1 max-h-40 overflow-y-auto border border-ink-100 rounded p-2">
            {products.length === 0 ? (
              <div className="text-xs text-ink-500">
                No products yet.
              </div>
            ) : (
              products.map((p) => (
                <label key={p.id} className="flex items-center gap-2 text-xs text-ink-700">
                  <input type="checkbox" name="product_ids" value={p.id} />
                  <span>{p.name}</span>
                </label>
              ))
            )}
          </div>
        </fieldset>

        <fieldset>
          <legend className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
            Platforms in scope
          </legend>
          <div className="mt-1 flex flex-wrap gap-3">
            {platforms.map((p) => (
              <label key={p} className="flex items-center gap-2 text-xs text-ink-700">
                <input type="checkbox" name="platforms" value={p} />
                <span>{PLATFORM_LABELS[p] ?? p}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
            What Signal can do
          </legend>
          <div className="mt-1 grid grid-cols-1 md:grid-cols-2 gap-1">
            {actionTypes.map((a) => (
              <label key={a.value} className="flex items-center gap-2 text-xs text-ink-700">
                <input type="checkbox" name="allowed_actions" value={a.value} />
                <span>{a.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
            Allowed publishing hours
          </legend>
          <p className="text-[11px] text-ink-500 mt-1 leading-relaxed">
            Signal can publish only during these windows. Times shown in{" "}
            <span className="font-mono">{tz}</span>.
          </p>
          <div className="mt-2 space-y-2">
            {windows.map((w, idx) => (
              <div
                key={w.id}
                className="flex flex-wrap items-center gap-2 text-xs text-ink-700"
              >
                <select
                  name="window_day"
                  defaultValue={w.dayOfWeek}
                  className="input min-w-[5rem]"
                  aria-label="Day"
                >
                  {DAY_LABELS.map((label, i) => (
                    <option key={label} value={i}>
                      {label}
                    </option>
                  ))}
                </select>
                <input
                  type="time"
                  name="window_start"
                  defaultValue={w.startTime}
                  className="input min-w-[6rem]"
                  aria-label="From"
                />
                <span className="text-ink-400">to</span>
                <input
                  type="time"
                  name="window_end"
                  defaultValue={w.endTime}
                  className="input min-w-[6rem]"
                  aria-label="Until"
                />
                <button
                  type="button"
                  className="text-[11px] text-ink-500 hover:text-red-600"
                  onClick={() => setWindows((ws) => ws.filter((_, i) => i !== idx))}
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              className="text-xs text-signal-700 hover:underline"
              onClick={() => {
                const id = nextWindowId.current++;
                setWindows((ws) => [
                  ...ws,
                  { id, dayOfWeek: 1, startTime: "09:00", endTime: "12:00" },
                ]);
              }}
            >
              + Add another window
            </button>
          </div>
        </fieldset>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="flex items-center gap-2 text-xs text-ink-700">
            <input
              type="checkbox"
              name="pause_on_first_failure"
              defaultChecked
            />
            <span>Pause publishing if any post fails</span>
          </label>
          <label className="flex items-center gap-2 text-xs text-ink-700">
            <input
              type="checkbox"
              name="pause_on_risk_event"
              defaultChecked
            />
            <span>Pause if something looks risky</span>
          </label>
        </div>

        <label className="block">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
            Notes
          </div>
          <textarea
            name="notes"
            rows={2}
            className="input w-full"
            placeholder="Optional. What's special about this week?"
          />
        </label>

        {!safe.ok && safe.error ? (
          <p className="text-xs text-red-700">{safe.error}</p>
        ) : null}

        <SubmitButton />
      </form>
    </section>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn-primary text-sm" disabled={pending}>
      {pending ? "Saving…" : "Save draft"}
    </button>
  );
}
