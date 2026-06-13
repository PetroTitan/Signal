"use client";

import { useFormState, useFormStatus } from "react-dom";
import {
  markAllReadAction,
  markNotificationAction,
  sendDigestNowAction,
  updateNotificationPreferencesAction,
  type SendDigestResult,
} from "./_actions";
import type { ActionResult } from "@/lib/forms/action-result";
import type { DigestCadence } from "@/lib/supabase/types";

const initial: ActionResult = { ok: false, error: "" };
const sendInitial: SendDigestResult = { ok: false, error: "" };

function SubmitLink({ idle, busy }: { idle: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="text-[11px] text-ink-500 hover:text-ink-800 disabled:opacity-50"
    >
      {pending ? busy : idle}
    </button>
  );
}

/** Per-row mark-read / archive controls (RLS scopes to the caller). */
export function NotificationRowActions({
  id,
  status,
}: {
  id: string;
  status: "unread" | "read" | "archived";
}) {
  const [, markRead] = useFormState(markNotificationAction, initial);
  const [, archive] = useFormState(markNotificationAction, initial);
  return (
    <div className="flex items-center gap-3 shrink-0">
      {status === "unread" ? (
        <form action={markRead}>
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="status" value="read" />
          <SubmitLink idle="Mark read" busy="…" />
        </form>
      ) : null}
      {status !== "archived" ? (
        <form action={archive}>
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="status" value="archived" />
          <SubmitLink idle="Archive" busy="…" />
        </form>
      ) : null}
    </div>
  );
}

export function MarkAllReadButton({ disabled }: { disabled: boolean }) {
  const [, action] = useFormState(markAllReadAction, initial);
  const { pending } = useFormStatus();
  return (
    <form action={action}>
      <button
        type="submit"
        disabled={disabled || pending}
        className="btn-ghost text-xs disabled:opacity-40"
      >
        Mark all read
      </button>
    </form>
  );
}

export interface PreferencesValue {
  emailEnabled: boolean;
  telegramEnabled: boolean;
  digestCadence: DigestCadence;
  connectionWarningDays: number;
}

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="btn-primary text-xs disabled:opacity-50">
      {pending ? "Saving…" : "Save preferences"}
    </button>
  );
}

export function PreferencesForm({ value }: { value: PreferencesValue }) {
  const [state, action] = useFormState(updateNotificationPreferencesAction, initial);
  return (
    <form action={action} className="space-y-4">
      <label className="flex items-center gap-2.5 text-sm text-ink-800">
        <input
          type="checkbox"
          name="email_enabled"
          defaultChecked={value.emailEnabled}
          className="h-4 w-4 rounded border-ink-300"
        />
        Email digest
        <span className="text-[11px] text-ink-400">
          (no email provider configured yet — preview only)
        </span>
      </label>
      <label className="flex items-center gap-2.5 text-sm text-ink-800">
        <input
          type="checkbox"
          name="telegram_enabled"
          defaultChecked={value.telegramEnabled}
          className="h-4 w-4 rounded border-ink-300"
        />
        Telegram digest
      </label>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-ink-700" htmlFor="digest_cadence">
          Digest cadence
        </label>
        <select
          id="digest_cadence"
          name="digest_cadence"
          defaultValue={value.digestCadence}
          className="input text-sm max-w-[12rem]"
        >
          <option value="disabled">Disabled</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-ink-700" htmlFor="connection_warning_days">
          Warn me this many days before a connection expires
        </label>
        <input
          id="connection_warning_days"
          name="connection_warning_days"
          type="number"
          min={0}
          max={30}
          defaultValue={value.connectionWarningDays}
          className="input text-sm max-w-[8rem]"
        />
      </div>
      <div className="flex items-center gap-3">
        <SaveButton />
        {state.ok ? <span className="text-[11px] text-green-600">Saved.</span> : null}
        {state.error ? <span className="text-[11px] text-red-600">{state.error}</span> : null}
      </div>
    </form>
  );
}

function SendButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="btn-ghost text-xs disabled:opacity-50">
      {pending ? "Sending…" : "Send digest now"}
    </button>
  );
}

export function DigestControls({ preview }: { preview: string }) {
  const [state, action] = useFormState(sendDigestNowAction, sendInitial);
  return (
    <div className="space-y-3">
      {preview ? (
        <pre className="whitespace-pre-wrap rounded-md bg-ink-50 px-3 py-2 text-[12px] text-ink-700 font-sans">
          {preview}
        </pre>
      ) : (
        <p className="text-xs text-ink-500">Nothing to report right now.</p>
      )}
      <form action={action} className="flex items-center gap-3">
        <SendButton />
        {state.ok && "detail" in state ? (
          <span className="text-[11px] text-ink-600">{state.detail}</span>
        ) : null}
        {state.error ? <span className="text-[11px] text-red-600">{state.error}</span> : null}
      </form>
    </div>
  );
}
