"use client";

/**
 * Phase F6.0 — platform-native shape summary (read-only).
 *
 * Renders the operator-visible summary of "what will publish, how,
 * where media goes" computed via the platform-native adapter
 * registry. Used inside the compose modal and the weekly-plan card
 * preview affordance.
 *
 * What this surfaces
 * ------------------
 *   - Platform
 *   - Operator intent (or "—" for legacy)
 *   - Provider format (single_post / thread / article / unknown)
 *   - Part count + per-part budget
 *   - Media attachment target
 *   - Reply / quote targets when present
 *   - Payload hash (live-computed via Web Crypto)
 *   - Adapter warnings + blockers, including the "Stub adapter" /
 *     "Legacy payload mode" badges
 *
 * Hard rules
 * ----------
 *   - Pure read-only. No mutations. No saves. No publish triggers.
 *   - Does not import any platform-specific adapter directly — only
 *     the registry. That keeps the platform isolation contract.
 *   - Renders the SAME ProviderPayloadPreview the publisher would
 *     produce for the same shape (the adapter is the canonical
 *     producer; the UI just displays its output).
 */

import { useEffect, useMemo, useState } from "react";
import type { PublishPlatform } from "@/core/publishing/publishing-types";
import {
  computeProviderPayloadHash,
  getPlatformAdapter,
  legacyPlatformNativeShape,
  parsePlatformNativeShape,
  type AdapterCreative,
  type PlatformNativeShape,
  type ProviderPayloadPreview,
} from "@/core/platform-native";

export interface PlatformShapeSummaryProps {
  platform: PublishPlatform;
  /** Plan-item title (may be ignored by the adapter per platform). */
  title: string | null;
  /** Plan-item body. */
  body: string;
  /** Optional creative. */
  creative: AdapterCreative | null;
  /**
   * Raw JSONB envelope from weekly_plan_items.platform_publish_intent
   * (or null when the row is in legacy mode). The component parses
   * via parsePlatformNativeShape; malformed envelopes fall back to
   * legacy mode.
   */
  rawIntent: Record<string, unknown> | null;
  /**
   * Platform-specific routing target (Reddit: subreddit; Telegram:
   * chat / channel; LinkedIn: company URN). Adapters that don't
   * consume it ignore. Passed-through verbatim — UI never branches
   * on platform.
   */
  target?: string | null;
  /** Outbound URL for link-post intents. */
  linkUrl?: string | null;
  /** Tag list (article platforms, YouTube). */
  tags?: ReadonlyArray<string>;
}

export function PlatformShapeSummary(props: PlatformShapeSummaryProps) {
  const adapter = useMemo(
    () => getPlatformAdapter(props.platform),
    [props.platform],
  );

  const shape = useMemo<PlatformNativeShape>(() => {
    const parsed = props.rawIntent
      ? parsePlatformNativeShape(props.rawIntent, props.platform)
      : null;
    return parsed ?? legacyPlatformNativeShape(props.platform);
  }, [props.rawIntent, props.platform]);

  const preview = useMemo<ProviderPayloadPreview | null>(() => {
    if (!adapter) return null;
    return adapter.buildPreview({
      title: props.title,
      body: props.body,
      identity: { displayName: null, handle: null, avatarUrl: null },
      creative: props.creative,
      shape,
      target: props.target ?? null,
      linkUrl: props.linkUrl ?? null,
      tags: props.tags,
    });
  }, [
    adapter,
    props.title,
    props.body,
    props.creative,
    shape,
    props.target,
    props.linkUrl,
    props.tags,
  ]);

  const [liveHash, setLiveHash] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!preview) {
      setLiveHash(null);
      return;
    }
    computeProviderPayloadHash(preview)
      .then((h) => {
        if (!cancelled) setLiveHash(h);
      })
      .catch(() => {
        if (!cancelled) setLiveHash(null);
      });
    return () => {
      cancelled = true;
    };
  }, [preview]);

  if (!adapter) {
    return (
      <SummaryShell title={props.platform}>
        <Row label="Adapter">
          <span className="text-red-700">
            No adapter registered for platform &quot;{props.platform}&quot;.
          </span>
        </Row>
      </SummaryShell>
    );
  }

  const isLegacy = shape.intent === "unknown";
  const isStub = adapter.capabilities.stub;
  const approvedHash = shape.operatorApprovedShapeHash;
  const hashStillCurrent =
    approvedHash !== null && liveHash !== null && approvedHash === liveHash;

  return (
    <SummaryShell title={props.platform}>
      {isStub ? (
        <p className="text-[11px] text-amber-700 leading-relaxed mb-1.5">
          <span className="font-semibold">Stub adapter.</span> Provider shape
          for this platform is not yet modeled. The operator cannot bind
          approval to a provider shape until the {props.platform} adapter
          PR ships. Existing publish behavior is unchanged.
        </p>
      ) : null}
      {isLegacy && !isStub ? (
        <p className="text-[11px] text-amber-700 leading-relaxed mb-1.5">
          <span className="font-semibold">Legacy payload mode.</span> Signal
          will infer provider shape from the body at publish time. New posts
          should explicitly set a platform-native intent.
        </p>
      ) : null}

      <Row label="Platform">{props.platform}</Row>
      <Row label="Intent">{isLegacy ? "— (legacy)" : shape.intent}</Row>
      <Row label="Format">{preview?.format ?? "unknown"}</Row>
      <Row label="Parts">
        {preview ? `${preview.parts.length}` : "—"}
        {adapter.capabilities.budgets.perPartBudget !== null ? (
          <span className="text-ink-500">
            {" "}
            (budget {adapter.capabilities.budgets.perPartBudget}{" "}
            {adapter.capabilities.budgets.perPartUnit})
          </span>
        ) : null}
      </Row>
      <Row label="Media">
        {preview ? mediaDescription(preview) : "—"}
      </Row>
      <Row label="Reply">
        {shape.replyTarget
          ? `${shape.replyTarget.url ?? shape.replyTarget.externalId ?? "—"}`
          : "no"}
      </Row>
      <Row label="Quote">
        {shape.quoteTarget
          ? `${shape.quoteTarget.url ?? shape.quoteTarget.externalId ?? "—"}`
          : "no"}
      </Row>
      <Row label="Payload hash">
        {liveHash ? (
          <code className="text-[10px]">{liveHash.slice(0, 24)}…</code>
        ) : (
          <span className="text-ink-500">computing…</span>
        )}
      </Row>
      {approvedHash ? (
        <Row label="Approved hash">
          <code className="text-[10px]">{approvedHash.slice(0, 24)}…</code>
          {hashStillCurrent ? (
            <span className="ml-2 text-emerald-700">matches</span>
          ) : liveHash ? (
            <span className="ml-2 text-amber-700">
              stale — operator approval bound to a different shape
            </span>
          ) : null}
        </Row>
      ) : null}

      {preview?.routing && Object.keys(preview.routing).length > 0 ? (
        <div className="mt-1.5">
          <div className="text-[10px] uppercase tracking-wide text-ink-500">
            provider routing
          </div>
          <dl className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-0.5 text-[11px] mt-0.5">
            {Object.keys(preview.routing)
              .sort()
              .map((key) => (
                <div key={key} className="contents">
                  <dt className="text-ink-500 font-mono">{key}</dt>
                  <dd className="text-ink-800 break-all">
                    {preview.routing![key] ?? "—"}
                  </dd>
                </div>
              ))}
          </dl>
        </div>
      ) : null}

      {preview && preview.warnings.length > 0 ? (
        <div className="mt-1.5">
          <div className="text-[10px] uppercase tracking-wide text-ink-500">
            warnings
          </div>
          <ul className="text-[11px] text-ink-700 space-y-0.5 mt-0.5">
            {preview.warnings.map((w, i) => (
              <li key={i}>· {w}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {preview && preview.blockers.length > 0 ? (
        <div className="mt-1.5">
          <div className="text-[10px] uppercase tracking-wide text-red-700">
            blockers
          </div>
          <ul className="text-[11px] text-red-800 space-y-0.5 mt-0.5">
            {preview.blockers.map((b, i) => (
              <li key={i}>
                · <span className="font-mono text-[10px]">{b.code}</span> —{" "}
                {b.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </SummaryShell>
  );
}

function mediaDescription(preview: ProviderPayloadPreview): string {
  if (preview.parts.length === 0) return "—";
  const partWithMedia = preview.parts.find((p) => p.media.attached);
  if (!partWithMedia) return "no media attached";
  return `image attached to part ${partWithMedia.index}${
    partWithMedia.media.altText
      ? ` (alt: "${partWithMedia.media.altText.slice(0, 40)}${
          partWithMedia.media.altText.length > 40 ? "…" : ""
        }")`
      : " (no alt text)"
  }`;
}

function SummaryShell(props: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-ink-200 bg-white px-3 py-2.5 mt-2 space-y-1">
      <div className="text-[10px] uppercase tracking-wide text-ink-500">
        Platform-native shape — {props.title}
      </div>
      {props.children}
    </div>
  );
}

function Row(props: { label: string; children: React.ReactNode }) {
  return (
    <div className="text-[11px] grid grid-cols-[110px_1fr] gap-x-3">
      <span className="text-ink-500">{props.label}</span>
      <span className="text-ink-800">{props.children}</span>
    </div>
  );
}
