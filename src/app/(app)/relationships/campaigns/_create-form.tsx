"use client";
/**
 * Create a campaign.
 *
 * Creates it as a DRAFT. Activation is a separate, explicit step with
 * its own confirmation copy — so configuring a campaign and starting
 * one are never the same click.
 */

import { useFormState, useFormStatus } from "react-dom";
import { createCampaignAction, type CreateCampaignResult } from "./_actions";
import { DAILY_QUOTA_OPTIONS } from "@/core/bluesky-campaigns/quota";
import { COMMON_TIMEZONES } from "@/core/bluesky-campaigns/campaign-day";
import { formatIdentityLabel } from "@/core/bluesky-relationships/handle-display";

const EMPTY: CreateCampaignResult = { ok: false, error: "" };

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn-primary" disabled={pending}>
      {pending ? "Creating…" : "Create draft campaign"}
    </button>
  );
}

export function CreateCampaignForm(props: {
  identities: { id: string; handle: string | null; displayName: string | null }[];
}) {
  const [state, action] = useFormState(createCampaignAction, EMPTY);

  return (
    <section className="card card-padded">
      <h2 className="section-title">New campaign</h2>
      <form action={action} className="mt-3 space-y-3">
        <div>
          <label htmlFor="name" className="stat-label">
            Campaign name
          </label>
          <input
            id="name"
            name="name"
            className="input w-full mt-1"
            placeholder="Designers who follow @someone"
            maxLength={120}
          />
        </div>

        <div>
          <label htmlFor="identity" className="stat-label">
            Acting Bluesky identity
          </label>
          <select id="identity" name="operator_account_id" className="input w-full mt-1">
            {props.identities.map((i) => (
              <option key={i.id} value={i.id}>
                {formatIdentityLabel(i)}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="quota" className="stat-label">
              Requested daily quota
            </label>
            <select
              id="quota"
              name="requested_daily_quota"
              defaultValue="100"
              className="input w-full mt-1"
            >
              {DAILY_QUOTA_OPTIONS.map((q) => (
                <option key={q} value={q}>
                  {q} / day
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="timezone" className="stat-label">
              Timezone
            </label>
            <select
              id="timezone"
              name="timezone"
              defaultValue="UTC"
              className="input w-full mt-1"
            >
              {COMMON_TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label htmlFor="window_start" className="stat-label">
              Window starts
            </label>
            <input
              id="window_start"
              name="window_start"
              type="time"
              defaultValue="09:00"
              className="input w-full mt-1"
            />
          </div>
          <div>
            <label htmlFor="window_end" className="stat-label">
              Window ends
            </label>
            <input
              id="window_end"
              name="window_end"
              type="time"
              defaultValue="20:00"
              className="input w-full mt-1"
            />
          </div>
          <div>
            <label htmlFor="start_date" className="stat-label">
              Start date (optional)
            </label>
            <input
              id="start_date"
              name="start_date"
              type="date"
              className="input w-full mt-1"
            />
          </div>
        </div>

        <label className="flex items-start gap-2 text-sm text-ink-700">
          <input type="checkbox" name="dry_run" value="1" className="mt-1 w-5 h-5" />
          <span className="leading-relaxed">
            Dry run — walk the queue and record outcomes without sending a single
            request to Bluesky. Nothing is followed.
          </span>
        </label>

        <p className="text-sm text-ink-700 leading-relaxed border border-amber-200 bg-amber-50 rounded-md p-3">
          Follows are <strong>public</strong> and the accounts may be notified.
          Signal respects Bluesky&apos;s rate limits and will attempt fewer than
          your requested quota whenever the provider, the account&apos;s
          remaining allowance or a safety check says so. This creates a draft —
          nothing runs until you activate it.
        </p>

        <Submit />
        {state.ok ? (
          <p className="text-sm text-emerald-700 leading-relaxed">
            Draft created. Import profiles into its queue, then activate.
          </p>
        ) : state.error ? (
          <p className="text-sm text-red-700 leading-relaxed">{state.error}</p>
        ) : null}
      </form>
    </section>
  );
}
