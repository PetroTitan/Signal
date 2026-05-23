"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { publishItemAction, type PublishItemResult } from "./_actions";

const CONFIRMATION_PHRASE = "publish live reddit post";
const initial: PublishItemResult = { ok: false, error: "" };

export interface PublishFormProps {
  executionItemId: string;
  defaultSubreddit: string;
  payloadPreview: {
    title: string;
    body: string | null;
    kind: "self" | "link";
    linkUrl: string | null;
    subreddit: string;
    apiPayload: Record<string, string>;
  };
}

export function PublishForm(props: PublishFormProps) {
  const [phrase, setPhrase] = useState("");
  const armed = phrase.trim().toLowerCase().replace(/\s+/g, " ") === CONFIRMATION_PHRASE;
  const [state, action] = useFormState(publishItemAction, initial);
  const safe = state ?? initial;

  return (
    <form action={action} className="card p-5 space-y-3 border-red-200">
      <div className="text-sm font-semibold text-red-700">
        ⚠️ This will REALLY post to Reddit.
      </div>
      <p className="text-xs text-ink-700 leading-relaxed">
        Clicking Publish will issue a real{" "}
        <span className="font-mono">POST /api/submit</span> to{" "}
        <span className="font-mono">r/{props.payloadPreview.subreddit}</span>{" "}
        as the connected account. There is no undo. The post will be public
        on Reddit immediately.
      </p>

      <input
        type="hidden"
        name="execution_item_id"
        value={props.executionItemId}
      />
      <input
        type="hidden"
        name="subreddit"
        value={props.defaultSubreddit}
      />

      <label className="block text-xs">
        <div className="font-semibold text-ink-700 mb-1">
          Confirmation phrase
        </div>
        <input
          type="text"
          name="confirmation_phrase"
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          autoComplete="off"
          placeholder='Type: publish live reddit post'
          className="input w-full font-mono text-sm"
        />
        <div className="text-[11px] text-ink-500 mt-1">
          The Publish button arms when you type the phrase{" "}
          <span className="font-mono text-ink-700">
            &quot;{CONFIRMATION_PHRASE}&quot;
          </span>{" "}
          exactly.
        </div>
      </label>

      <div className="flex items-center gap-3">
        <PublishButton disabled={!armed} />
        {safe.ok ? (
          <span className="text-xs text-emerald-700">
            ✓ Published.{" "}
            {safe.permalink ? (
              <a
                href={safe.permalink}
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                Open on Reddit
              </a>
            ) : null}
          </span>
        ) : safe.error ? (
          <span className="text-xs text-amber-700">{safe.error}</span>
        ) : null}
      </div>
    </form>
  );
}

function PublishButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      className="btn-primary text-sm disabled:opacity-50"
    >
      {pending ? "Publishing…" : "Publish to Reddit"}
    </button>
  );
}
