"use client";

import { useFormState, useFormStatus } from "react-dom";
import { COMMON_TIMEZONES } from "@/core/bluesky-campaigns/campaign-day";
import { createCampaignAction, type CampaignResult } from "../_actions";

const EMPTY: CampaignResult = { ok: false, error: "" };

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn-primary min-h-11 w-full sm:w-auto" disabled={pending}>
      {pending ? "Saving…" : "Save as draft"}
    </button>
  );
}

export function CampaignForm(props: {
  lists: { id: string; name: string }[];
  sequences: { id: string; name: string }[];
  defaultTimezone: string;
}) {
  const [state, dispatch] = useFormState(createCampaignAction, EMPTY);
  const timezones = COMMON_TIMEZONES.includes(props.defaultTimezone as (typeof COMMON_TIMEZONES)[number])
    ? COMMON_TIMEZONES
    : [props.defaultTimezone, ...COMMON_TIMEZONES];
  return (
    <form action={dispatch} className="card card-padded space-y-4" aria-labelledby="new-campaign-heading">
      <h3 id="new-campaign-heading" className="section-title">New campaign</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <label className="block text-sm">
          <span className="block font-medium text-ink-800 mb-1">Name</span>
          <input name="name" required maxLength={120} className="input w-full min-h-11" />
        </label>
        <label className="block text-sm">
          <span className="block font-medium text-ink-800 mb-1">Lead list</span>
          <select name="lead_list_id" required className="input w-full min-h-11" defaultValue="">
            <option value="" disabled>Choose a list</option>
            {props.lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
        <label className="block text-sm">
          <span className="block font-medium text-ink-800 mb-1">Sequence</span>
          <select name="sequence_id" required className="input w-full min-h-11" defaultValue="">
            <option value="" disabled>Choose a sequence</option>
            {props.sequences.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="block text-sm">
          <span className="block font-medium text-ink-800 mb-1">Timezone</span>
          <select name="timezone" defaultValue={props.defaultTimezone} className="input w-full min-h-11">
            {timezones.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
          </select>
        </label>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-ink-800">Working window</legend>
        <p className="text-sm text-ink-600 leading-relaxed">Tasks are prepared only between these local times, so they are waiting when you sit down to work.</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-md">
          <label className="block text-sm">
            <span className="block font-medium text-ink-800 mb-1">From</span>
            <input type="time" name="window_start" defaultValue="09:00" required className="input w-full min-h-11" />
          </label>
          <label className="block text-sm">
            <span className="block font-medium text-ink-800 mb-1">To</span>
            <input type="time" name="window_end" defaultValue="18:00" required className="input w-full min-h-11" />
          </label>
        </div>
      </fieldset>
      <label className="block text-sm max-w-md">
        <span className="block font-medium text-ink-800 mb-1">Tasks prepared per day</span>
        <input type="number" name="daily_task_target" min={1} max={200} defaultValue={10} required className="input w-full min-h-11" />
        <span className="block text-ink-600 mt-1 leading-relaxed">
          How many tasks Signal prepares for you on each local day of this campaign. This is a workload setting for you.
          It is not a LinkedIn limit, and Signal does not know one; how you act on LinkedIn is yours to judge.
        </span>
      </label>
      {state.error ? <p role="alert" className="text-sm text-red-700">{state.error}</p> : null}
      {state.ok ? <p role="status" className="text-sm text-green-800">{state.message}</p> : null}
      <Submit />
    </form>
  );
}
