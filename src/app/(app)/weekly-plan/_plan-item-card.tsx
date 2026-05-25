"use client";

import { useState } from "react";
import Link from "next/link";
import { useFormState, useFormStatus } from "react-dom";
import {
  approvePlanItemAndHoldAction,
  approvePlanItemAndScheduleAction,
  duplicatePlanItemAction,
  scheduleApprovedItemAction,
  sendForApprovalAction,
  updatePlanItemAction,
  type ApprovePlanItemResult,
  type DuplicatePlanItemResult,
  type SendForApprovalResult,
  type UpdatePlanItemResult,
} from "./_actions";
import { describeCreativeState } from "./approval-readiness.shared";
import { deriveApproveActionsState } from "./approve-actions-ui";
import {
  CreativeCard,
  type CreativeCardData,
} from "@/components/publishing/creative-card";
import { ExecutionStateBadge } from "@/components/publishing/execution-state";
import { SchedulePresetsInput } from "@/components/publishing/schedule-presets-input";
import { SubredditPill } from "@/components/publishing/subreddit-pill";
import { PlatformChip } from "@/components/publishing/platform-chip";
import { AiAssistedChip } from "@/components/publishing/ai-assisted-chip";
import { RemoveButton } from "./_remove-button";
import {
  FounderComposeSheet,
  type FounderComposeSheetDefaults,
} from "@/components/founder-compose/founder-compose-sheet";
import { MiniPreview } from "@/components/platform-preview/MiniPreview";
import { asPreviewPlatform } from "@/core/platform-preview/preview-renderer";

const updateInitial: UpdatePlanItemResult = { ok: false, error: "" };
const duplicateInitial: DuplicatePlanItemResult = { ok: false, error: "" };
const sendInitial: SendForApprovalResult = { ok: false, error: "" };
const approveItemInitial: ApprovePlanItemResult = { ok: false, error: "" };

/**
 * Lightweight, sheet-driven plan item card.
 *
 * F2.9.5 — the card is a preview + quick actions, NOT an editor.
 * Title / body / Edit all open the unified FounderComposeSheet,
 * preloaded with this item's data. The card never owns title/body
 * input state anymore.
 */

export interface PlanItemCardProps {
  id: string;
  title: string | null;
  body: string | null;
  platform: string | null;
  contentType: string | null;
  productId: string | null;
  accountId: string | null;
  scheduledAt: string | null;
  /** Persisted in metadata.schedule_source by saveScheduleAction. */
  scheduleSource: string | null;
  status: import("@/lib/supabase/types").WeeklyPlanItemStatus;
  riskScore: number | null;
  notes: string | null;
  isPost: boolean;
  warnings: string[];
  timezoneLabel: string | null;
  subreddit: string | null;
  products: { id: string; name: string }[];
  accounts: { id: string; displayName: string | null; platform: string }[];
  allowedSubreddits: string[];
  /** True when an active weekly contract exists for the workspace.
   *  Required only for immediate-schedule per-item approval and bulk
   *  paths; per-item hold approval works regardless. */
  hasActiveContract: boolean;
  creative: CreativeCardData | null;
  executionItemId: string | null;
  executionItemStatus: string | null;
  /** F4.6.1 — null when the draft is purely manual. */
  aiAssistedKind: "ai_draft" | "ai_assisted" | null;
}

export function PlanItemCard(props: PlanItemCardProps) {
  const [composeOpen, setComposeOpen] = useState(false);

  const composeDefaults: FounderComposeSheetDefaults = {
    timezoneLabel: props.timezoneLabel,
    defaultAccountId: props.accountId,
    defaultProductId: props.productId,
    defaultSubreddit: props.subreddit ?? props.allowedSubreddits[0] ?? "test",
    accounts: props.accounts,
    products: props.products,
    allowedSubreddits: props.allowedSubreddits,
  };

  const isDraft = props.status === "draft" || props.status === "skipped";
  const accountLabel = props.accountId
    ? props.accounts.find((a) => a.id === props.accountId)
    : null;

  return (
    <>
      <article
        id={`plan-item-${props.id}`}
        // The id is the deep-link anchor target. The compose-sheet
        // "Open in weekly plan" button navigates to
        // /weekly-plan?focus=<id> and a small client mount-effect
        // (see _focus-on-mount.tsx) scrolls this element into view
        // and applies a brief ring highlight.
        className="rounded-2xl border border-ink-200 bg-white overflow-hidden scroll-mt-20"
      >
        <div className="grid grid-cols-1 md:grid-cols-[1fr_180px]">
          <div className="p-4 md:p-5 space-y-2 min-w-0">
            {/* Title (clickable) */}
            <button
              type="button"
              onClick={() => setComposeOpen(true)}
              className="block text-left w-full"
            >
              <h3 className="text-sm font-semibold text-ink-900 leading-snug hover:text-signal-700">
                {props.title ?? "Untitled draft"}
              </h3>
            </button>

            {/* Body preview (also clickable) — platform-native mini when
                we have a renderer for this platform and the item is past
                draft state; otherwise raw line-clamped body. */}
            <button
              type="button"
              onClick={() => setComposeOpen(true)}
              className="block text-left w-full"
            >
              {(() => {
                const previewPlatform = props.platform
                  ? asPreviewPlatform(props.platform)
                  : null;
                const showMini =
                  previewPlatform !== null &&
                  props.body &&
                  props.body.trim().length > 0 &&
                  (props.status === "pending_approval" ||
                    props.status === "approved" ||
                    props.status === "scheduled");
                if (showMini && previewPlatform) {
                  return (
                    <MiniPreview
                      platform={previewPlatform}
                      input={{
                        title: props.title,
                        body: props.body!,
                        identity: {
                          displayName:
                            props.accounts.find((a) => a.id === props.accountId)
                              ?.displayName ?? null,
                          handle: null,
                          avatarUrl: null,
                        },
                        creative: props.creative
                          ? {
                              assetUrl: props.creative.assetUrl,
                              altText: props.creative.altText,
                              sourceType: props.creative.sourceType,
                            }
                          : null,
                      }}
                    />
                  );
                }
                if (props.body) {
                  return (
                    <p className="text-xs text-ink-700 leading-relaxed line-clamp-3">
                      {props.body}
                    </p>
                  );
                }
                return (
                  <p className="text-xs text-ink-400 italic">
                    No body yet — click to continue writing.
                  </p>
                );
              })()}
            </button>

            {/* Status / target / schedule / account chips */}
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              <ExecutionStateBadge status={props.status} />
              {props.platform ? <PlatformChip platform={props.platform} /> : null}
              {props.aiAssistedKind ? (
                <AiAssistedChip kind={props.aiAssistedKind} />
              ) : null}
              {props.isPost && props.platform === "reddit" ? (
                <SubredditPill
                  subreddit={props.subreddit}
                  allowedList={props.allowedSubreddits}
                />
              ) : !props.isPost ? (
                <span className="inline-flex items-center rounded-full border border-dashed border-ink-300 px-2 py-0.5 text-[11px] text-ink-500">
                  comment draft
                </span>
              ) : null}
              {props.scheduledAt ? (
                <span className="inline-flex items-center rounded-full border border-ink-200 px-2 py-0.5 text-[11px] text-ink-700">
                  {formatSchedule(props.scheduledAt)}
                </span>
              ) : (
                <span className="inline-flex items-center rounded-full border border-dashed border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700">
                  unscheduled
                </span>
              )}
              {accountLabel ? (
                <span className="text-[11px] text-ink-500">
                  {accountLabel.displayName ?? accountLabel.id}
                </span>
              ) : null}
            </div>

            {/* Warnings — only on posts with real issues */}
            {props.isPost && props.warnings.length > 0 ? (
              <div className="rounded-md bg-amber-50 border border-amber-100 px-3 py-2 mt-1">
                <div className="text-[11px] font-semibold text-amber-800 mb-0.5">
                  Resolve before approval
                </div>
                <ul className="text-[11px] text-amber-800 leading-relaxed space-y-0.5">
                  {props.warnings.map((w, i) => (
                    <li key={i}>· {w}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {/* Post vs creative status — clear separation so the
                operator never has to guess whether "Approved" refers
                to the creative or the post. */}
            {props.isPost ? (
              <PostCreativeStatusSummary
                postStatus={props.status}
                creative={props.creative}
                hasWarnings={props.warnings.length > 0}
              />
            ) : null}

            {/* Quick actions — title, body, and creative already open the
                sheet on click, so no redundant "Edit" button here. */}
            <div className="flex flex-wrap items-center gap-1.5 pt-2">
              {props.executionItemId && props.executionItemStatus === "ready" ? (
                <Link
                  href={`/execution/items/${props.executionItemId}`}
                  className="btn-primary text-xs"
                >
                  Open preview →
                </Link>
              ) : props.executionItemId &&
                props.executionItemStatus === "ready_for_manual_publish" ? (
                <Link
                  href={`/execution/items/${props.executionItemId}`}
                  className="btn-primary text-xs"
                >
                  Publish manually →
                </Link>
              ) : props.executionItemId &&
                props.executionItemStatus === "completed" ? (
                <Link
                  href={`/execution/items/${props.executionItemId}`}
                  className="btn-ghost text-xs"
                >
                  View published →
                </Link>
              ) : null}
              {isDraft && props.isPost ? (
                <SendForApprovalButton itemId={props.id} />
              ) : null}
              {props.status === "pending_approval" && props.isPost ? (
                <PerItemApproveButtons
                  itemId={props.id}
                  scheduleSet={props.scheduledAt !== null}
                  hasActiveContract={props.hasActiveContract}
                />
              ) : null}
              {(props.status === "approved" || props.status === "paused") &&
              props.isPost &&
              props.scheduledAt !== null ? (
                <ScheduleApprovedItemButton
                  itemId={props.id}
                  isRetry={props.status === "paused"}
                />
              ) : null}
              <QuickReschedule
                itemId={props.id}
                scheduledAt={props.scheduledAt}
                timezoneLabel={props.timezoneLabel}
              />
              <DuplicateButton itemId={props.id} />
              <RemoveButton itemId={props.id} status={props.status} />
            </div>
          </div>

          {/* Creative thumbnail */}
          <div className="md:border-l md:border-ink-100 p-3 md:p-4 order-first md:order-none">
            {props.isPost ? (
              <button
                type="button"
                onClick={() => setComposeOpen(true)}
                className="block w-full text-left"
              >
                <CreativeCard creative={props.creative} density="compact" />
              </button>
            ) : (
              <div className="text-[11px] text-ink-400 italic text-center py-6">
                Creative not required for comments
              </div>
            )}
          </div>
        </div>
      </article>

      <FounderComposeSheet
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        defaults={composeDefaults}
        existingItem={{
          itemId: props.id,
          status: props.status,
          title: props.title,
          body: props.body,
          platform: props.platform,
          contentType: props.contentType,
          subreddit: props.subreddit,
          accountId: props.accountId,
          productId: props.productId,
          scheduledAtIso: props.scheduledAt,
          scheduleSource: props.scheduleSource,
          hasActiveContract: props.hasActiveContract,
          riskScore: props.riskScore,
          notes: props.notes,
          creative: props.creative
            ? {
                id: props.creative.id,
                assetUrl: props.creative.assetUrl,
                altText: props.creative.altText,
                sourceType: props.creative.sourceType,
              }
            : null,
        }}
      />
    </>
  );
}

// =====================================================================
// Quick actions (kept lightweight — popovers, no full forms)
// =====================================================================

function SendForApprovalButton({ itemId }: { itemId: string }) {
  const [state, action] = useFormState(sendForApprovalAction, sendInitial);
  const safe = state ?? sendInitial;
  return (
    <form action={action} className="inline">
      <input type="hidden" name="item_id" value={itemId} />
      <SendSubmit />
      {safe.error ? (
        <span className="ml-2 text-[11px] text-amber-700">{safe.error}</span>
      ) : null}
    </form>
  );
}

function SendSubmit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="btn-primary text-xs disabled:opacity-60"
    >
      {pending ? "Sending…" : "Send for approval"}
    </button>
  );
}

function DuplicateButton({ itemId }: { itemId: string }) {
  const [state, action] = useFormState(
    duplicatePlanItemAction,
    duplicateInitial,
  );
  const safe = state ?? duplicateInitial;
  return (
    <form action={action} className="inline">
      <input type="hidden" name="item_id" value={itemId} />
      <DupSubmit />
      {safe.error ? (
        <span className="ml-2 text-[11px] text-amber-700">{safe.error}</span>
      ) : null}
    </form>
  );
}

function DupSubmit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="btn-ghost text-xs disabled:opacity-60"
    >
      {pending ? "Duplicating…" : "Duplicate"}
    </button>
  );
}

function QuickReschedule({
  itemId,
  scheduledAt,
  timezoneLabel,
}: {
  itemId: string;
  scheduledAt: string | null;
  timezoneLabel: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="btn-ghost text-xs"
      >
        {open ? "Close" : scheduledAt ? "Reschedule" : "Schedule"}
      </button>
      {open ? (
        <div
          className="fixed md:absolute z-30 inset-x-2 md:inset-x-auto md:left-0 mt-1 md:w-72 rounded-lg border border-ink-200 bg-white shadow-lg p-3"
        >
          <ReschedulePopover
            itemId={itemId}
            defaultIso={scheduledAt}
            timezoneLabel={timezoneLabel}
            onSaved={() => setOpen(false)}
          />
        </div>
      ) : null}
    </div>
  );
}

function ReschedulePopover({
  itemId,
  defaultIso,
  timezoneLabel,
  onSaved,
}: {
  itemId: string;
  defaultIso: string | null;
  timezoneLabel: string | null;
  onSaved: () => void;
}) {
  const [state, formAction] = useFormState(
    updatePlanItemAction,
    updateInitial,
  );
  const safe = state ?? updateInitial;
  if (safe.ok && safe.itemId === itemId) {
    queueMicrotask(onSaved);
  }
  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="item_id" value={itemId} />
      <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
        Reschedule
      </div>
      <SchedulePresetsInput
        name="scheduled_at"
        defaultValueIso={defaultIso}
        timezoneLabel={timezoneLabel}
      />
      <ReschedSubmit />
      {safe.error ? (
        <span className="block text-[11px] text-amber-700">{safe.error}</span>
      ) : null}
    </form>
  );
}

function ReschedSubmit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="btn-primary text-xs disabled:opacity-60"
    >
      {pending ? "Saving…" : "Save schedule"}
    </button>
  );
}

function formatSchedule(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// =====================================================================
// Post + creative status summary — explicit separation so an
// "Approved" badge on the creative is never confused with post
// approval.
// =====================================================================

function PostCreativeStatusSummary({
  postStatus,
  creative,
  hasWarnings,
}: {
  postStatus: import("@/lib/supabase/types").WeeklyPlanItemStatus;
  creative: CreativeCardData | null;
  hasWarnings: boolean;
}) {
  const creativeState = describeCreativeState(creative);
  const postLabel = postStatusLabel(postStatus);
  // Cross-state helper copy.
  let helper: { tone: "ok" | "warn"; text: string } | null = null;
  if (postStatus === "pending_approval") {
    if (creativeState.tone === "ok" && !hasWarnings) {
      helper = { tone: "ok", text: "Ready for post approval." };
    } else if (creativeState.tone === "ok") {
      helper = {
        tone: "warn",
        text: "Creative is approved. Post still needs approval.",
      };
    }
  } else if (postStatus === "approved") {
    helper = {
      tone: "ok",
      text:
        "Approved. Schedule via the Schedule button or signal.schedule_publish (MCP).",
    };
  } else if (postStatus === "scheduled") {
    helper = { tone: "ok", text: "Scheduled. The scheduler will publish it." };
  }
  return (
    <div className="rounded-md border border-ink-100 bg-ink-50/40 px-3 py-2 mt-1 space-y-1">
      <div className="grid grid-cols-2 gap-3 text-[11px]">
        <div>
          <div className="text-ink-500 uppercase tracking-wide text-[10px]">
            Post
          </div>
          <div className="text-ink-900 font-medium mt-0.5">{postLabel}</div>
        </div>
        <div>
          <div className="text-ink-500 uppercase tracking-wide text-[10px]">
            Creative
          </div>
          <div
            className={`font-medium mt-0.5 ${
              creativeState.tone === "ok"
                ? "text-emerald-700"
                : creativeState.tone === "needs_review"
                  ? "text-amber-700"
                  : creativeState.tone === "blocked"
                    ? "text-red-700"
                    : "text-ink-600"
            }`}
          >
            {creativeState.label}
          </div>
        </div>
      </div>
      {helper ? (
        <p
          className={`text-[11px] leading-relaxed ${
            helper.tone === "ok" ? "text-emerald-700" : "text-amber-700"
          }`}
        >
          {helper.text}
        </p>
      ) : null}
    </div>
  );
}

function postStatusLabel(
  status: import("@/lib/supabase/types").WeeklyPlanItemStatus,
): string {
  switch (status) {
    case "draft":
      return "Draft";
    case "pending_approval":
      return "Awaiting post approval";
    case "approved":
      return "Approved";
    case "scheduled":
      return "Scheduled";
    case "published":
      return "Published";
    case "rejected":
      return "Rejected";
    case "skipped":
      return "Skipped";
    case "backlog":
      return "Backlog";
    case "paused":
      return "Paused";
    default:
      return status;
  }
}

// =====================================================================
// Per-item approve buttons — Approve post + Approve & hold.
// Available on pending_approval items. Refuses the schedule path
// when no scheduled_at is set, with a calm inline note.
// =====================================================================

function PerItemApproveButtons({
  itemId,
  scheduleSet,
  hasActiveContract,
}: {
  itemId: string;
  scheduleSet: boolean;
  hasActiveContract: boolean;
}) {
  const [holdState, holdAction] = useFormState(
    approvePlanItemAndHoldAction,
    approveItemInitial,
  );
  const [scheduleState, scheduleAction] = useFormState(
    approvePlanItemAndScheduleAction,
    approveItemInitial,
  );
  const holdSafe = holdState ?? approveItemInitial;
  const scheduleSafe = scheduleState ?? approveItemInitial;

  const actions = deriveApproveActionsState({
    scheduleSet,
    hasActiveContract,
    otherBlocker: null,
  });

  // Error scoping — when the hold path succeeds, suppress the
  // schedule-path error so the operator doesn't see a stale banner
  // for a path they no longer care about.
  const showScheduleError = scheduleSafe.error && !holdSafe.ok;
  const showHoldError = holdSafe.error && !scheduleSafe.ok;

  return (
    <div className="inline-flex flex-wrap items-end gap-1.5">
      {actions.schedulePost.kind === "enabled" ? (
        <form action={scheduleAction} className="inline">
          <input type="hidden" name="item_id" value={itemId} />
          <ApprovePostSubmit />
        </form>
      ) : (
        <span
          className="inline-flex items-center text-[11px] text-ink-500 italic"
          title={actions.schedulePost.hint}
        >
          {actions.schedulePost.kind === "disabled_no_schedule"
            ? "No schedule — approve & hold first"
            : "Approve post unavailable"}
        </span>
      )}
      <form action={holdAction} className="inline">
        <input type="hidden" name="item_id" value={itemId} />
        <ApproveAndHoldSubmit />
      </form>
      {showScheduleError ? (
        <span
          className="text-[11px] text-amber-700 ml-1 max-w-xs"
          data-error-scope="schedule"
        >
          {scheduleSafe.error}{" "}
          <span className="text-ink-500">
            You can still approve &amp; hold this post.
          </span>
        </span>
      ) : showHoldError ? (
        <span
          className="text-[11px] text-amber-700 ml-1 max-w-xs"
          data-error-scope="hold"
        >
          {holdSafe.error}
        </span>
      ) : null}
    </div>
  );
}

function ApprovePostSubmit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="btn-primary text-xs disabled:opacity-60"
    >
      {pending ? "Approving…" : "Approve post"}
    </button>
  );
}

function ApproveAndHoldSubmit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="btn-secondary text-xs disabled:opacity-60"
    >
      {pending ? "Approving…" : "Approve & hold"}
    </button>
  );
}

// =====================================================================
// Schedule-an-already-approved-item button.
// Renders next to Reschedule on cards where status is "approved" (or
// "paused") AND scheduled_at is set. Calls scheduleApprovedItemAction
// — which creates the execution_item the scheduler needs. Without
// this, an approved item with scheduled_at would never publish:
// saveScheduleAction only updates weekly_plan_items.scheduled_at, but
// the scheduler reads execution_items.
// =====================================================================

function ScheduleApprovedItemButton({
  itemId,
  isRetry,
}: {
  itemId: string;
  /** Plan-item is in status="paused" (recovery from a failed/
   *  blocked execution attempt). Changes the button label so the
   *  operator understands they're retrying rather than scheduling
   *  for the first time. */
  isRetry: boolean;
}) {
  const [state, action] = useFormState(
    scheduleApprovedItemAction,
    approveItemInitial,
  );
  const safe = state ?? approveItemInitial;
  return (
    <form action={action} className="inline">
      <input type="hidden" name="item_id" value={itemId} />
      <ScheduleForPublishSubmit isRetry={isRetry} />
      {safe.error ? (
        <span className="ml-1 text-[11px] text-amber-700">{safe.error}</span>
      ) : null}
    </form>
  );
}

function ScheduleForPublishSubmit({ isRetry }: { isRetry: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="btn-primary text-xs disabled:opacity-60"
    >
      {pending
        ? "Scheduling…"
        : isRetry
          ? "Schedule retry"
          : "Schedule for publish"}
    </button>
  );
}
