"use client";

import { useFormState, useFormStatus } from "react-dom";
import { useState } from "react";
import { inviteMemberAction, type InviteResult } from "./_actions";
import { ASSIGNABLE_INVITE_ROLES, roleLabel } from "@/core/teams/permissions";

const initial: InviteResult = { ok: false, error: "" };

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="btn-primary disabled:opacity-50">
      {pending ? "Inviting…" : "Send invite"}
    </button>
  );
}

export function InviteForm() {
  const [state, formAction] = useFormState(inviteMemberAction, initial);
  const [copied, setCopied] = useState(false);
  const acceptUrl =
    state.ok && typeof window !== "undefined"
      ? `${window.location.origin}${state.acceptPath}`
      : null;

  return (
    <div className="space-y-3">
      <form action={formAction} className="flex flex-wrap items-end gap-2">
        <label className="block flex-1 min-w-[12rem]">
          <span className="text-[11px] text-ink-500">Email</span>
          <input type="email" name="email" required placeholder="teammate@example.com" className="input w-full mt-0.5" />
        </label>
        <label className="block">
          <span className="text-[11px] text-ink-500">Role</span>
          <select name="role" defaultValue="editor" className="input mt-0.5">
            {ASSIGNABLE_INVITE_ROLES.map((r) => (
              <option key={r} value={r}>{roleLabel(r)}</option>
            ))}
          </select>
        </label>
        <Submit />
      </form>

      {state.ok ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 space-y-1">
          <p>
            Invitation created for <span className="font-mono">{state.email}</span>.{" "}
            {state.alreadyHasAccount
              ? "They already have a Signal account and were notified in-app."
              : "Ask them to sign up, then open the link below to join."}
          </p>
          {acceptUrl ? (
            <div className="flex items-center gap-2">
              <input readOnly value={acceptUrl} className="input flex-1 text-[11px] font-mono bg-white" onFocus={(e) => e.currentTarget.select()} />
              <button
                type="button"
                className="btn text-[11px]"
                onClick={() => {
                  navigator.clipboard?.writeText(acceptUrl).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  });
                }}
              >
                {copied ? "Copied ✓" : "Copy link"}
              </button>
            </div>
          ) : null}
          <p className="text-[10px] text-emerald-700">
            No email is sent (no email provider is configured) — share this link directly. It expires in 7 days.
          </p>
        </div>
      ) : state.error ? (
        <p className="text-xs text-red-700">{state.error}</p>
      ) : null}
    </div>
  );
}
