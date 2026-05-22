"use client";

import { useFormState, useFormStatus } from "react-dom";
import {
  updateRegionAction,
  type SettingsActionState,
} from "./_actions";

const initial: SettingsActionState = { ok: false, error: null };

interface RegionFormProps {
  initialRegion: string | null;
  initialTimezone: string | null;
  initialLanguage: string | null;
}

export function RegionForm({
  initialRegion,
  initialTimezone,
  initialLanguage,
}: RegionFormProps) {
  const [state, formAction] = useFormState(updateRegionAction, initial);

  return (
    <form action={formAction} className="space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <label className="block">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
            Region
          </div>
          <input
            type="text"
            name="region"
            defaultValue={initialRegion ?? ""}
            placeholder="us_east"
            className="input w-full font-mono text-xs"
          />
        </label>
        <label className="block">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
            Timezone
          </div>
          <input
            type="text"
            name="timezone"
            defaultValue={initialTimezone ?? ""}
            placeholder="America/New_York"
            className="input w-full font-mono text-xs"
          />
        </label>
        <label className="block">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
            Language
          </div>
          <input
            type="text"
            name="language"
            defaultValue={initialLanguage ?? ""}
            placeholder="en-US"
            className="input w-full font-mono text-xs"
          />
        </label>
      </div>

      {state.error ? (
        <div
          role="alert"
          className={`text-xs leading-relaxed rounded-md px-3 py-2 ${
            state.ok
              ? "bg-emerald-50 text-emerald-800"
              : "bg-amber-50 text-amber-800"
          }`}
        >
          {state.error}
        </div>
      ) : state.ok ? (
        <div className="text-xs text-emerald-700">
          Saved {state.savedAt ? new Date(state.savedAt).toLocaleString() : ""}.
        </div>
      ) : null}

      <SubmitButton />
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="btn disabled:opacity-60">
      {pending ? "Saving…" : "Save region & locale"}
    </button>
  );
}
