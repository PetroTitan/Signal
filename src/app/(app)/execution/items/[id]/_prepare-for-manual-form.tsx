"use client";

import { useFormState, useFormStatus } from "react-dom";
import {
  prepareForManualPublishAction,
  type PrepareForManualPublishResult,
} from "./_actions";

const initial: PrepareForManualPublishResult = { ok: false, error: "" };

export interface PrepareForManualPublishFormProps {
  executionItemId: string;
  /** True when Reddit API publishing is unavailable (operator should
   *  see this option prominently). */
  apiBlocked: boolean;
}

export function PrepareForManualPublishForm(
  props: PrepareForManualPublishFormProps,
) {
  const [state, action] = useFormState(prepareForManualPublishAction, initial);
  const safe = state ?? initial;

  return (
    <section className="rounded-2xl border border-ink-200 bg-white p-5 space-y-3">
      <h2 className="text-sm font-semibold text-ink-900">
        Switch to manual publish
      </h2>
      <p className="text-xs text-ink-700 leading-relaxed">
        Signal will prepare this post for you to publish manually on Reddit.
        No automation, no logging in for you, no browser running on your
        behalf — you copy, you publish, you paste the permalink back. Every
        safety check still applies.
      </p>
      {props.apiBlocked ? (
        <p className="text-[11px] text-amber-700 leading-relaxed">
          Reddit&apos;s API approval is still pending, so manual publishing
          is the recommended path until that lands.
        </p>
      ) : null}
      <form action={action}>
        <input
          type="hidden"
          name="execution_item_id"
          value={props.executionItemId}
        />
        <div className="flex items-center gap-3">
          <SubmitButton />
          {safe.ok ? (
            <span className="text-xs text-emerald-700">
              ✓ Ready to publish manually.
            </span>
          ) : safe.error ? (
            <span className="text-xs text-amber-700">{safe.error}</span>
          ) : null}
        </div>
      </form>
    </section>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="btn-primary text-sm disabled:opacity-60"
    >
      {pending ? "Preparing…" : "Prepare for manual publish"}
    </button>
  );
}
