"use client";

import { useEffect, useRef, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import {
  createContractAction,
  type CreateContractResult,
} from "./_actions";

const initial: CreateContractResult = { ok: false, error: "" };

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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

  return (
    <section className="card p-5">
      <h2 className="text-sm font-semibold text-ink-900">Draft a new weekly contract</h2>
      <p className="text-xs text-ink-600 mt-1 leading-relaxed">
        Drafts are not active. After review, submit for approval, type the
        confirmation phrase, and activate it.
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
              Week start
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
              Week end
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
              Max actions / week
            </div>
            <input
              type="number"
              name="max_actions_total"
              min={0}
              placeholder="No cap"
              className="input w-full"
            />
          </label>

          <label className="block">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
              Max actions / day
            </div>
            <input
              type="number"
              name="max_actions_per_day"
              min={0}
              placeholder="No cap"
              className="input w-full"
            />
          </label>

          <label className="block">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
              Max actions / platform / day
            </div>
            <input
              type="number"
              name="max_actions_per_platform_per_day"
              min={0}
              placeholder="No cap"
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
                <span>{p}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
            Allowed actions
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
            Execution windows (local time)
          </legend>
          <div className="mt-2 space-y-2">
            {windows.map((w, idx) => (
              <div
                key={w.id}
                className="flex items-center gap-2 text-xs text-ink-700"
              >
                <select
                  name="window_day"
                  defaultValue={w.dayOfWeek}
                  className="input"
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
                  className="input"
                />
                <span>→</span>
                <input
                  type="time"
                  name="window_end"
                  defaultValue={w.endTime}
                  className="input"
                />
                <button
                  type="button"
                  className="text-ink-500 hover:text-red-600"
                  onClick={() => setWindows((ws) => ws.filter((_, i) => i !== idx))}
                >
                  remove
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
              + add window
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
            <span>Pause on first failure</span>
          </label>
          <label className="flex items-center gap-2 text-xs text-ink-700">
            <input
              type="checkbox"
              name="pause_on_risk_event"
              defaultChecked
            />
            <span>Pause on risk event</span>
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
