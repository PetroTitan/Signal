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
    creativeAssetUrl: string | null;
    altText: string | null;
  };
}

export function ManualPublishForm(props: ManualPublishFormProps) {
  const submitUrl = `https://www.reddit.com/r/${encodeURIComponent(
    props.payloadPreview.subreddit,
  )}/submit`;
  const fullPayload = buildFullPayloadText(props.payloadPreview);

  const [phrase, setPhrase] = useState("");
  const armed =
    phrase.trim().toLowerCase().replace(/\s+/g, " ") === CONFIRMATION_PHRASE;
  const [state, action] = useFormState(recordManualPublishAction, initial);
  const safe = state ?? initial;

  return (
    <section className="card p-5 space-y-4 border-emerald-200">
      <header>
        <h2 className="text-sm font-semibold text-ink-900">
          Manual publish mode
        </h2>
        <p className="text-xs text-ink-700 mt-1 leading-relaxed">
          Signal prepared this post. You publish it manually on Reddit. This
          does not use Reddit API automation. After publishing, paste the
          Reddit permalink here so Signal can record the audit row.
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <CopyButton label="Copy title" value={props.payloadPreview.title} />
        {props.payloadPreview.kind === "link" ? (
          <CopyButton
            label="Copy link URL"
            value={props.payloadPreview.linkUrl ?? ""}
          />
        ) : (
          <CopyButton
            label="Copy body"
            value={props.payloadPreview.body ?? ""}
          />
        )}
        <CopyButton label="Copy full payload" value={fullPayload} />
        {props.payloadPreview.creativeAssetUrl ? (
          <CopyButton
            label="Copy creative URL"
            value={props.payloadPreview.creativeAssetUrl}
          />
        ) : null}
        <a
          href={submitUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-ghost text-xs"
        >
          Open r/{props.payloadPreview.subreddit} submit page →
        </a>
      </div>

      <details className="text-xs text-ink-700">
        <summary className="cursor-pointer font-semibold text-ink-700">
          Show prepared payload
        </summary>
        <pre className="mt-2 bg-ink-50 p-3 rounded-md overflow-x-auto whitespace-pre-wrap font-mono text-[11px]">
          {fullPayload}
        </pre>
      </details>

      <ol className="text-xs text-ink-700 space-y-1 list-decimal list-inside leading-relaxed">
        <li>Copy the title and body using the buttons above.</li>
        <li>
          Open <span className="font-mono">r/{props.payloadPreview.subreddit}</span>{" "}
          submit page, attach the creative manually, and submit.
        </li>
        <li>
          Paste the permalink from your browser address bar into the form
          below.
        </li>
        <li>
          Type <span className="font-mono">&quot;{CONFIRMATION_PHRASE}&quot;</span>{" "}
          to arm the Record button.
        </li>
      </ol>

      <form action={action} className="space-y-3 border-t border-ink-100 pt-4">
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
            Reddit permalink (required)
          </div>
          <input
            type="url"
            name="permalink"
            placeholder="https://www.reddit.com/r/test/comments/abc123/some_slug/"
            required
            className="input w-full text-sm font-mono"
          />
          <div className="text-[11px] text-ink-500 mt-1">
            Accepts the full permalink or{" "}
            <span className="font-mono">https://redd.it/&lt;id&gt;</span>{" "}
            shortlink. The URL subreddit must match the prepared payload.
          </div>
        </label>
        <label className="block text-xs">
          <div className="font-semibold text-ink-700 mb-1">
            Operator notes (optional)
          </div>
          <textarea
            name="operator_notes"
            rows={2}
            placeholder="e.g. Posted from u/Webmasterid-core; flair set to Discussion."
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

function CopyButton({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // navigator.clipboard can be blocked in non-secure contexts; the
      // operator can still copy from the "Show prepared payload" pre.
      setCopied(false);
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      disabled={value.length === 0}
      className="btn-ghost text-xs disabled:opacity-50"
    >
      {copied ? "✓ Copied" : label}
    </button>
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
      {pending ? "Recording…" : "Mark as manually published"}
    </button>
  );
}

function buildFullPayloadText(payload: {
  title: string;
  body: string | null;
  kind: "self" | "link";
  linkUrl: string | null;
  subreddit: string;
  creativeAssetUrl: string | null;
  altText: string | null;
}): string {
  const lines = [
    `Subreddit: r/${payload.subreddit}`,
    `Type:      ${payload.kind === "link" ? "link" : "text post"}`,
    "",
    `Title:`,
    payload.title,
    "",
  ];
  if (payload.kind === "link" && payload.linkUrl) {
    lines.push(`URL:`, payload.linkUrl, "");
  } else if (payload.body) {
    lines.push(`Body:`, payload.body, "");
  }
  if (payload.creativeAssetUrl) {
    lines.push(`Creative:`, payload.creativeAssetUrl, "");
  }
  if (payload.altText) {
    lines.push(`Alt text:`, payload.altText, "");
  }
  return lines.join("\n").trimEnd();
}
