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
    <section className="card p-5 space-y-3">
      <h2 className="text-sm font-semibold text-ink-900">
        Manual publish mode
      </h2>
      <p className="text-xs text-ink-700 leading-relaxed">
        Signal prepared this post. You publish it manually on Reddit, then
        paste the permalink back. This does not use Reddit API automation,
        does not log in for you, and does not run a browser on your behalf.
        Every safety gate (whitelist, creative readiness, alt text, rate
        limit, duplicate, confirmation phrase) still applies.
      </p>
      {props.apiBlocked ? (
        <p className="text-[11px] text-amber-700 leading-relaxed">
          Reddit API publishing is unavailable right now (Responsible Builder
          Policy / API approval pending). The manual workflow is the
          recommended path until approval lands.
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
              ✓ Item moved to{" "}
              <span className="font-mono">ready_for_manual_publish</span>.
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
