"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import {
  recordManualPublishAction,
  type RecordManualPublishResult,
} from "./_actions";

const CONFIRMATION_PHRASE = "publish live reddit post";
const initial: RecordManualPublishResult = { ok: false, error: "" };

export interface ManualPublishFormProps {
  executionItemId: string;
  defaultSubreddit: string;
  payloadPreview: {
    title: string;
    body: string | null;
    kind: "self" | "link";
    linkUrl: string | null;
    subreddit: string;
  };
}

export function ManualPublishForm(props: ManualPublishFormProps) {
  const composeUrl = buildComposeUrl(props.payloadPreview);
  const [phrase, setPhrase] = useState("");
  const armed =
    phrase.trim().toLowerCase().replace(/\s+/g, " ") === CONFIRMATION_PHRASE;
  const [state, action] = useFormState(recordManualPublishAction, initial);
  const safe = state ?? initial;

  return (
    <section className="card p-5 space-y-4 border-amber-200 bg-amber-50/40">
      <header>
        <h2 className="text-sm font-semibold text-amber-900">
          Manual Reddit publish (API approval pending)
        </h2>
        <p className="text-xs text-amber-900 mt-1 leading-relaxed">
          Reddit hasn&apos;t approved Signal&apos;s API access yet. Use this
          flow to publish manually now; once approval lands the same
          payload + policy gates will run automatically. Every safety
          check still applies — whitelist, creative readiness, rate
          limit, duplicate, confirmation phrase.
        </p>
      </header>

      <ol className="text-xs text-ink-800 space-y-3 list-decimal list-inside leading-relaxed">
        <li>
          <span className="font-semibold">Copy the title</span> and{" "}
          {props.payloadPreview.kind === "link" ? "link URL" : "body"} from the
          payload preview above.
        </li>
        <li>
          <span className="font-semibold">Publish on Reddit.</span> Click the
          link below to open Reddit&apos;s compose page with{" "}
          <span className="font-mono">r/{props.payloadPreview.subreddit}</span>{" "}
          pre-filled, paste the title + body, and submit.
          <div className="mt-1">
            <a
              href={composeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-signal-700 underline font-mono break-all text-[11px]"
            >
              {composeUrl}
            </a>
          </div>
        </li>
        <li>
          <span className="font-semibold">Paste the permalink</span> from your
          browser&apos;s address bar after the post appears.
        </li>
        <li>
          <span className="font-semibold">Type the confirmation phrase</span>{" "}
          to record. We use the exact same phrase as the automated path so the
          audit trail is consistent.
        </li>
      </ol>

      <form action={action} className="space-y-3 border-t border-amber-200 pt-4">
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
            Reddit permalink (from your browser)
          </div>
          <input
            type="url"
            name="permalink"
            placeholder="https://www.reddit.com/r/test/comments/abc123/some_slug/"
            required
            className="input w-full text-sm font-mono"
          />
          <div className="text-[11px] text-ink-500 mt-1">
            Accepts the full permalink or a{" "}
            <span className="font-mono">https://redd.it/&lt;id&gt;</span>{" "}
            shortlink. The subreddit in the URL must match the prepared payload.
          </div>
        </label>
        <label className="block text-xs">
          <div className="font-semibold text-ink-700 mb-1">
            Operator notes (optional)
          </div>
          <textarea
            name="operator_notes"
            rows={2}
            placeholder="e.g. Posted at 14:32 from u/Webmasterid-core; flair set to Discussion."
            className="input w-full text-sm"
          />
        </label>
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
            The Record button arms when you type the phrase{" "}
            <span className="font-mono text-ink-700">
              &quot;{CONFIRMATION_PHRASE}&quot;
            </span>{" "}
            exactly.
          </div>
        </label>

        <div className="flex items-center gap-3">
          <RecordButton disabled={!armed} />
          {safe.ok ? (
            <span className="text-xs text-emerald-700">
              ✓ Recorded.{" "}
              <a
                href={safe.permalink}
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                Open on Reddit
              </a>
            </span>
          ) : safe.error ? (
            <span className="text-xs text-amber-700">{safe.error}</span>
          ) : null}
        </div>
      </form>
    </section>
  );
}

function RecordButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      className="btn-primary text-sm disabled:opacity-50"
    >
      {pending ? "Recording…" : "Record manual publish"}
    </button>
  );
}

function buildComposeUrl(payload: {
  title: string;
  body: string | null;
  kind: "self" | "link";
  linkUrl: string | null;
  subreddit: string;
}): string {
  const base = `https://www.reddit.com/r/${encodeURIComponent(payload.subreddit)}/submit`;
  const params = new URLSearchParams();
  params.set("title", payload.title);
  if (payload.kind === "link" && payload.linkUrl) {
    params.set("url", payload.linkUrl);
  } else if (payload.body) {
    params.set("text", payload.body);
    params.set("selftext", "true");
  }
  return `${base}?${params.toString()}`;
}
