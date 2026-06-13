"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useFormState, useFormStatus } from "react-dom";
import { acceptInvitationAction } from "../../settings/team/_actions";
import type { ActionResult } from "@/lib/forms/action-result";

const initial: ActionResult = { ok: false, error: "" };

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="btn-primary disabled:opacity-50">
      {pending ? "Joining…" : "Accept invitation"}
    </button>
  );
}

export function AcceptInvite({ token }: { token: string }) {
  const router = useRouter();
  const [state, action] = useFormState(acceptInvitationAction, initial);

  useEffect(() => {
    if (state.ok) {
      const t = setTimeout(() => router.push("/dashboard"), 800);
      return () => clearTimeout(t);
    }
  }, [state.ok, router]);

  if (!token) {
    return <p className="text-sm text-red-700">This invite link is missing its token.</p>;
  }

  if (state.ok) {
    return (
      <p className="text-sm text-emerald-700">
        You&apos;ve joined the workspace. Taking you to the dashboard…
      </p>
    );
  }

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="token" value={token} />
      <p className="text-sm text-ink-700">
        You&apos;ve been invited to join a Signal workspace. Accepting adds this
        account to the workspace with the role the inviter chose.
      </p>
      <Submit />
      {state.error ? <p className="text-xs text-red-700">{state.error}</p> : null}
    </form>
  );
}
