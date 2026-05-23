"use client";

import { useFormState, useFormStatus } from "react-dom";
import {
  publishTierOneAction,
  type PublishTierOneResult,
} from "./_publish-tier-one-action";

const initial: PublishTierOneResult = { ok: false, error: "" };

interface PublishTierOneFormProps {
  executionItemId: string;
  platform: "devto" | "hashnode" | "bluesky";
  /** When set, the strip renders a soft cooldown notice above the button. */
  cooldownWarning?: string | null;
}

const PLATFORM_LABEL: Record<
  PublishTierOneFormProps["platform"],
  string
> = {
  devto: "dev.to",
  hashnode: "Hashnode",
  bluesky: "Bluesky",
};

export function PublishTierOneForm(props: PublishTierOneFormProps) {
  const [state, action] = useFormState(publishTierOneAction, initial);
  const safe = state ?? initial;
  const label = PLATFORM_LABEL[props.platform];

  return (
    <form
      action={action}
      className="rounded-2xl border border-signal-200 bg-white p-5 space-y-3"
    >
      <div>
        <h2 className="text-sm font-semibold text-ink-900">
          Publish to {label}
        </h2>
        <p className="text-xs text-ink-600 mt-1 leading-relaxed">
          This sends the post straight to {label} using your stored
          credentials. There&apos;s no undo on {label} once it&apos;s live —
          you can delete it from their site if needed.
        </p>
      </div>
      {props.cooldownWarning ? (
        <p className="text-xs text-amber-700 leading-relaxed">
          {props.cooldownWarning}
        </p>
      ) : null}
      <input
        type="hidden"
        name="execution_item_id"
        value={props.executionItemId}
      />
      <div className="flex items-center gap-3">
        <PublishButton label={label} />
        {safe.ok ? (
          <span className="text-xs text-emerald-700 leading-relaxed">
            ✓ Published.{" "}
            {safe.permalink ? (
              <a
                href={safe.permalink}
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                Open on {label}
              </a>
            ) : null}
          </span>
        ) : safe.error ? (
          <span className="text-xs text-amber-700 leading-relaxed">
            {safe.error}
          </span>
        ) : null}
      </div>
    </form>
  );
}

function PublishButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="btn-primary text-sm disabled:opacity-50"
    >
      {pending ? "Publishing…" : `Publish to ${label}`}
    </button>
  );
}
