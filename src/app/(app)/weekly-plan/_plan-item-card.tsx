"use client";

import { useState } from "react";
import Link from "next/link";
import { useFormState, useFormStatus } from "react-dom";
import {
  attachCreativeAction,
  duplicatePlanItemAction,
  updatePlanItemAction,
  uploadCreativeAssetAction,
  type AttachCreativeResult,
  type DuplicatePlanItemResult,
  type UpdatePlanItemResult,
  type UploadCreativeAssetResult,
} from "./_actions";
import {
  CreativeCard,
  type CreativeCardData,
} from "@/components/publishing/creative-card";
import { ExecutionStateBadge } from "@/components/publishing/execution-state";
import { SchedulePresetsInput } from "@/components/publishing/schedule-presets-input";
import { SubredditPill } from "@/components/publishing/subreddit-pill";

const updateInitial: UpdatePlanItemResult = { ok: false, error: "" };
const creativeInitial: AttachCreativeResult = { ok: false, error: "" };
const uploadInitial: UploadCreativeAssetResult = { ok: false, error: "" };
const duplicateInitial: DuplicatePlanItemResult = { ok: false, error: "" };

export interface PlanItemCardProps {
  id: string;
  title: string | null;
  body: string | null;
  platform: string | null;
  contentType: string | null;
  productId: string | null;
  accountId: string | null;
  scheduledAt: string | null;
  status: import("@/lib/supabase/types").WeeklyPlanItemStatus;
  riskScore: number | null;
  notes: string | null;
  isPost: boolean;
  /** Operator-readable warnings (missing schedule, alt text, etc). */
  warnings: string[];
  /** Workspace timezone label, e.g. "Europe/Prague". */
  timezoneLabel: string | null;
  /** Subreddit (or platform-specific target) parsed from metadata.target. */
  subreddit: string | null;
  products: { id: string; name: string }[];
  accounts: { id: string; displayName: string | null; platform: string }[];
  /** Workspace's ALLOWED_TEST_SUBREDDITS, lowercased without /r/.
   *  Passed in by the server page so the client card stays env-free. */
  allowedSubreddits: string[];
  creative: CreativeCardData | null;
  /** Linked execution_item, if any. Drives the "open preview / publish" link. */
  executionItemId: string | null;
  executionItemStatus: string | null;
}

type EditorStage = "content" | "publishing" | "review";

export function PlanItemCard(props: PlanItemCardProps) {
  const [editing, setEditing] = useState(false);
  const [stage, setStage] = useState<EditorStage>("content");

  return (
    <article className="rounded-2xl border border-ink-200 bg-white overflow-hidden">
      <div className="grid grid-cols-1 md:grid-cols-[1fr_180px]">
        <div className="p-4 md:p-5 space-y-2 min-w-0">
          {/* Title first */}
          <h3 className="text-sm font-semibold text-ink-900 leading-snug">
            {props.title ?? "Untitled draft"}
          </h3>

          {/* Body preview */}
          {props.body ? (
            <p className="text-xs text-ink-700 leading-relaxed line-clamp-3">
              {props.body}
            </p>
          ) : (
            <p className="text-xs text-ink-400 italic">No body yet.</p>
          )}

          {/* Schedule + platform/account chips (secondary) */}
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <ExecutionStateBadge status={props.status} />
            {props.isPost ? (
              <SubredditPill
                subreddit={props.subreddit}
                allowedList={props.allowedSubreddits}
              />
            ) : (
              <span className="inline-flex items-center rounded-full border border-dashed border-ink-300 px-2 py-0.5 text-[11px] text-ink-500">
                draft-only (comment)
              </span>
            )}
            {props.scheduledAt ? (
              <span className="inline-flex items-center rounded-full border border-ink-200 px-2 py-0.5 text-[11px] text-ink-700">
                {formatSchedule(props.scheduledAt)}
              </span>
            ) : (
              <span className="inline-flex items-center rounded-full border border-dashed border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700">
                unscheduled
              </span>
            )}
            {props.accountId
              ? (() => {
                  const acct = props.accounts.find(
                    (a) => a.id === props.accountId,
                  );
                  return acct ? (
                    <span className="text-[11px] text-ink-500">
                      {acct.displayName ?? acct.id} · {acct.platform}
                    </span>
                  ) : null;
                })()
              : null}
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

          {/* Quick actions */}
          <div className="flex flex-wrap items-center gap-1.5 pt-2">
            <button
              type="button"
              onClick={() => {
                setEditing((v) => !v);
                if (!editing) setStage("content");
              }}
              className="btn-ghost text-xs"
            >
              {editing ? "Close" : "Edit"}
            </button>
            {props.executionItemId && props.executionItemStatus === "ready" ? (
              <Link
                href={`/execution/items/${props.executionItemId}`}
                className="btn-primary text-xs"
              >
                Ready — open preview →
              </Link>
            ) : props.executionItemId &&
              props.executionItemStatus === "ready_for_manual_publish" ? (
              <Link
                href={`/execution/items/${props.executionItemId}`}
                className="btn-primary text-xs"
              >
                Manual publish →
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
            <DuplicateButton itemId={props.id} />
            <QuickReschedule
              itemId={props.id}
              scheduledAt={props.scheduledAt}
              timezoneLabel={props.timezoneLabel}
            />
          </div>
        </div>

        {/* Creative thumbnail on the right (or below on mobile) */}
        <div className="md:border-l md:border-ink-100 p-3 md:p-4 order-first md:order-none">
          {props.isPost ? (
            <CreativeCard creative={props.creative} density="compact" />
          ) : (
            <div className="text-[11px] text-ink-400 italic text-center py-6">
              Creative not required for comments
            </div>
          )}
        </div>
      </div>

      {editing ? (
        <div className="border-t border-ink-100 bg-ink-50/40">
          <StageNav stage={stage} setStage={setStage} />
          {stage === "content" ? (
            <ContentStage
              itemId={props.id}
              defaultTitle={props.title ?? ""}
              defaultBody={props.body ?? ""}
              defaultStatus={props.status}
              creative={props.creative}
            />
          ) : stage === "publishing" ? (
            <PublishingStage
              itemId={props.id}
              defaultPlatform={props.platform ?? ""}
              defaultContentType={props.contentType ?? "post"}
              defaultProductId={props.productId ?? ""}
              defaultAccountId={props.accountId ?? ""}
              defaultScheduledAtIso={props.scheduledAt}
              defaultRiskScore={props.riskScore}
              defaultNotes={props.notes ?? ""}
              defaultSubreddit={props.subreddit ?? ""}
              products={props.products}
              accounts={props.accounts}
              timezoneLabel={props.timezoneLabel}
            />
          ) : (
            <ReviewStage
              isPost={props.isPost}
              warnings={props.warnings}
              creative={props.creative}
              scheduledAt={props.scheduledAt}
              subreddit={props.subreddit}
            />
          )}
        </div>
      ) : null}
    </article>
  );
}

function StageNav({
  stage,
  setStage,
}: {
  stage: EditorStage;
  setStage: (s: EditorStage) => void;
}) {
  const stages: { id: EditorStage; label: string }[] = [
    { id: "content", label: "1. Content" },
    { id: "publishing", label: "2. Publishing" },
    { id: "review", label: "3. Review" },
  ];
  return (
    <div className="flex border-b border-ink-100">
      {stages.map((s) => (
        <button
          key={s.id}
          type="button"
          onClick={() => setStage(s.id)}
          className={`px-4 py-2.5 text-xs font-medium border-b-2 transition-colors ${
            stage === s.id
              ? "border-signal-500 text-ink-900 bg-white"
              : "border-transparent text-ink-500 hover:text-ink-700"
          }`}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}

// =====================================================================
// Stage 1 — Content
// =====================================================================

function ContentStage(props: {
  itemId: string;
  defaultTitle: string;
  defaultBody: string;
  defaultStatus: import("@/lib/supabase/types").WeeklyPlanItemStatus;
  creative: CreativeCardData | null;
}) {
  const [state, formAction] = useFormState(
    updatePlanItemAction,
    updateInitial,
  );
  const safe = state ?? updateInitial;
  const editableStatus =
    props.defaultStatus === "draft" ||
    props.defaultStatus === "pending_approval" ||
    props.defaultStatus === "skipped"
      ? props.defaultStatus
      : "";

  return (
    <div className="p-4 md:p-5 grid grid-cols-1 md:grid-cols-[1fr_260px] gap-4">
      <form action={formAction} className="space-y-3 min-w-0">
        <input type="hidden" name="item_id" value={props.itemId} />
        <label className="block">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
            Title
          </div>
          <input
            type="text"
            name="title"
            defaultValue={props.defaultTitle}
            placeholder="A clear, specific hook"
            className="input w-full text-base"
          />
        </label>
        <label className="block">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
            Body
          </div>
          <textarea
            name="body"
            rows={8}
            defaultValue={props.defaultBody}
            placeholder="The post itself. Markdown supported on Reddit selftext."
            className="input w-full text-sm leading-relaxed"
          />
        </label>
        <label className="block">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
            Draft state
          </div>
          <select
            name="status"
            defaultValue={editableStatus}
            className="input w-full md:w-auto text-sm"
          >
            <option value="">— keep current —</option>
            <option value="draft">Save as draft</option>
            <option value="pending_approval">Send for approval</option>
            <option value="skipped">Skip this week</option>
          </select>
        </label>
        <div className="flex items-center gap-3 pt-1">
          <SaveButton label="Save content" />
          {safe.ok ? (
            <span className="text-[11px] text-emerald-700">Saved.</span>
          ) : safe.error ? (
            <span className="text-[11px] text-amber-700">{safe.error}</span>
          ) : null}
        </div>
      </form>

      <div className="space-y-2 min-w-0">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
          Creative
        </div>
        <CreativeCard creative={props.creative} density="compact" />
        <UploadCtas itemId={props.itemId} creativeId={props.creative?.id ?? null} />
        <details className="text-xs">
          <summary className="cursor-pointer text-ink-500 hover:text-ink-700">
            Advanced creative metadata
          </summary>
          <CreativeMetadataForm
            itemId={props.itemId}
            creative={props.creative}
          />
        </details>
      </div>
    </div>
  );
}

function UploadCtas({
  itemId,
  creativeId,
}: {
  itemId: string;
  creativeId: string | null;
}) {
  const [state, formAction] = useFormState(
    uploadCreativeAssetAction,
    uploadInitial,
  );
  const safe = state ?? uploadInitial;
  return (
    <form action={formAction} className="space-y-1.5">
      <input type="hidden" name="item_id" value={itemId} />
      {creativeId ? (
        <input type="hidden" name="creative_id" value={creativeId} />
      ) : null}
      <label className="block">
        <input
          type="file"
          name="file"
          accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm"
          className="text-xs file:mr-3 file:px-2 file:py-1 file:rounded-md file:border-0 file:bg-ink-100 file:text-ink-700 hover:file:bg-ink-200 file:cursor-pointer"
          required
        />
      </label>
      <UploadButton />
      <p className="text-[10px] text-ink-400 leading-relaxed">
        Screenshot, image, or short video — up to 10 MB image / 100 MB
        video. Allowed: jpg · png · webp · gif · mp4 · webm.
      </p>
      {safe.ok ? (
        <div className="text-[11px] text-emerald-700">
          ✓ Uploaded — saved to creative.
        </div>
      ) : safe.error ? (
        <div className="text-[11px] text-amber-700">{safe.error}</div>
      ) : null}
    </form>
  );
}

function CreativeMetadataForm({
  itemId,
  creative,
}: {
  itemId: string;
  creative: CreativeCardData | null;
}) {
  const [state, formAction] = useFormState(
    attachCreativeAction,
    creativeInitial,
  );
  const safe = state ?? creativeInitial;
  return (
    <form action={formAction} className="mt-2 space-y-2">
      <input type="hidden" name="item_id" value={itemId} />
      {creative ? (
        <input type="hidden" name="creative_id" value={creative.id} />
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-[11px]">
          <div className="text-ink-500 mb-0.5">Source</div>
          <select
            name="source_type"
            defaultValue={creative?.sourceType ?? "uploaded"}
            className="input w-full text-xs"
          >
            <option value="uploaded">Uploaded</option>
            <option value="generated">Generated</option>
            <option value="wikimedia">Wikimedia / CC</option>
            <option value="official_source">Official source</option>
            <option value="manual_url">Manual URL</option>
            <option value="planned">Planned (placeholder)</option>
          </select>
        </label>
        <label className="block text-[11px]">
          <div className="text-ink-500 mb-0.5">Type</div>
          <select
            name="creative_type"
            defaultValue={creative?.creativeType ?? "image"}
            className="input w-full text-xs"
          >
            <option value="image">Image</option>
            <option value="video">Video</option>
            <option value="animation">Animation</option>
          </select>
        </label>
      </div>
      <label className="block text-[11px]">
        <div className="text-ink-500 mb-0.5">Alt text (required)</div>
        <input
          name="alt_text"
          defaultValue={creative?.altText ?? ""}
          className="input w-full text-xs"
        />
      </label>
      <details className="text-[11px] text-ink-500">
        <summary className="cursor-pointer">External source fields</summary>
        <div className="mt-1 space-y-1.5">
          <label className="block">
            <div className="text-ink-500 mb-0.5">Source URL</div>
            <input
              name="source_url"
              defaultValue={creative?.sourceUrl ?? ""}
              className="input w-full text-xs font-mono"
            />
          </label>
          <label className="block">
            <div className="text-ink-500 mb-0.5">License</div>
            <input
              name="license"
              defaultValue={creative?.license ?? ""}
              className="input w-full text-xs"
            />
          </label>
          <label className="block">
            <div className="text-ink-500 mb-0.5">Attribution</div>
            <input
              name="attribution"
              defaultValue={creative?.attribution ?? ""}
              className="input w-full text-xs"
            />
          </label>
          <label className="block">
            <div className="text-ink-500 mb-0.5">Prompt (for generated)</div>
            <input
              name="prompt"
              defaultValue={creative?.prompt ?? ""}
              className="input w-full text-xs"
            />
          </label>
        </div>
      </details>
      <label className="flex items-start gap-2 text-[11px]">
        <input
          type="checkbox"
          name="approve_now"
          defaultChecked={creative?.altText !== null}
          className="mt-0.5"
        />
        <span className="text-ink-700">
          Approve creative — confirms alt text, license, and that
          it&apos;s ready for the publishing queue.
        </span>
      </label>
      <div className="flex items-center gap-2">
        <SaveButton label={creative ? "Save creative" : "Attach creative"} />
        {safe.ok ? (
          <span className="text-[11px] text-emerald-700">Saved.</span>
        ) : safe.error ? (
          <span className="text-[11px] text-amber-700">{safe.error}</span>
        ) : null}
      </div>
    </form>
  );
}

// =====================================================================
// Stage 2 — Publishing
// =====================================================================

function PublishingStage(props: {
  itemId: string;
  defaultPlatform: string;
  defaultContentType: string;
  defaultProductId: string;
  defaultAccountId: string;
  defaultScheduledAtIso: string | null;
  defaultRiskScore: number | null;
  defaultNotes: string;
  defaultSubreddit: string;
  products: { id: string; name: string }[];
  accounts: { id: string; displayName: string | null; platform: string }[];
  timezoneLabel: string | null;
}) {
  const [state, formAction] = useFormState(
    updatePlanItemAction,
    updateInitial,
  );
  const safe = state ?? updateInitial;
  return (
    <form
      action={formAction}
      className="p-4 md:p-5 grid grid-cols-1 md:grid-cols-2 gap-4"
    >
      <input type="hidden" name="item_id" value={props.itemId} />
      <label className="block text-xs">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
          Platform
        </div>
        <select
          name="platform"
          defaultValue={props.defaultPlatform}
          className="input w-full text-sm"
        >
          <option value="">—</option>
          <option value="reddit">Reddit</option>
          <option value="x">X</option>
          <option value="linkedin">LinkedIn</option>
        </select>
      </label>
      <label className="block text-xs">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
          Content type
        </div>
        <select
          name="content_type"
          defaultValue={props.defaultContentType}
          className="input w-full text-sm"
        >
          <option value="post">Post</option>
          <option value="comment">Comment (draft-only)</option>
        </select>
      </label>
      <label className="block text-xs">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
          Account
        </div>
        <select
          name="account_id"
          defaultValue={props.defaultAccountId}
          className="input w-full text-sm"
        >
          <option value="">—</option>
          {props.accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {(a.displayName ?? a.id) + " · " + a.platform}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-xs">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
          Product
        </div>
        <select
          name="product_id"
          defaultValue={props.defaultProductId}
          className="input w-full text-sm"
        >
          <option value="">—</option>
          {props.products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <div className="md:col-span-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
          Schedule
        </div>
        <SchedulePresetsInput
          name="scheduled_at"
          defaultValueIso={props.defaultScheduledAtIso}
          timezoneLabel={props.timezoneLabel}
        />
      </div>
      <label className="block text-xs">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
          Risk (0–100)
        </div>
        <input
          type="number"
          name="risk_score"
          min={0}
          max={100}
          defaultValue={props.defaultRiskScore ?? ""}
          className="input w-full text-sm"
        />
      </label>
      <label className="block text-xs md:col-span-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
          Operator notes (private)
        </div>
        <textarea
          name="notes"
          rows={2}
          defaultValue={props.defaultNotes}
          className="input w-full text-sm"
        />
      </label>
      <div className="md:col-span-2 flex items-center gap-3">
        <SaveButton label="Save publishing settings" />
        {safe.ok ? (
          <span className="text-[11px] text-emerald-700">Saved.</span>
        ) : safe.error ? (
          <span className="text-[11px] text-amber-700">{safe.error}</span>
        ) : null}
      </div>
    </form>
  );
}

// =====================================================================
// Stage 3 — Review
// =====================================================================

function ReviewStage(props: {
  isPost: boolean;
  warnings: string[];
  creative: CreativeCardData | null;
  scheduledAt: string | null;
  subreddit: string | null;
}) {
  const ready = props.isPost && props.warnings.length === 0;
  return (
    <div className="p-4 md:p-5 space-y-3">
      <div
        className={`rounded-lg border px-4 py-3 ${
          ready
            ? "border-emerald-200 bg-emerald-50/50"
            : "border-amber-200 bg-amber-50/50"
        }`}
      >
        <div
          className={`text-sm font-semibold ${
            ready ? "text-emerald-800" : "text-amber-800"
          }`}
        >
          {ready
            ? "✓ Ready for the publishing queue"
            : "Resolve these before approval"}
        </div>
        {props.warnings.length > 0 ? (
          <ul className="text-xs text-ink-700 mt-1 space-y-0.5">
            {props.warnings.map((w, i) => (
              <li key={i}>· {w}</li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-ink-700 mt-1">
            Approve the weekly plan from the top of /weekly-plan, or send
            this item back to draft via Content → Draft state.
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <ReadinessTile
          label="Schedule"
          ok={!props.isPost || Boolean(props.scheduledAt)}
          detail={
            props.scheduledAt
              ? formatSchedule(props.scheduledAt)
              : "Set a date/time in Publishing"
          }
        />
        <ReadinessTile
          label="Subreddit"
          ok={!props.isPost || Boolean(props.subreddit)}
          detail={props.subreddit ? `r/${props.subreddit}` : "Set a target"}
        />
        <ReadinessTile
          label="Creative"
          ok={
            !props.isPost ||
            (props.creative?.status === "approved" &&
              Boolean(
                props.creative?.assetUrl || props.creative?.sourceUrl,
              ) &&
              Boolean(props.creative?.altText))
          }
          detail={
            !props.isPost
              ? "Not required"
              : props.creative
                ? props.creative.status === "approved"
                  ? "Approved + alt text + asset"
                  : "Needs approval / fields"
                : "Attach a creative"
          }
        />
      </div>
    </div>
  );
}

function ReadinessTile({
  label,
  ok,
  detail,
}: {
  label: string;
  ok: boolean;
  detail: string;
}) {
  return (
    <div
      className={`rounded-md border px-3 py-2 ${
        ok ? "border-emerald-100 bg-emerald-50/50" : "border-amber-100 bg-amber-50/50"
      }`}
    >
      <div className="flex items-center gap-1.5">
        <span
          className={`w-1.5 h-1.5 rounded-full ${ok ? "bg-emerald-500" : "bg-amber-500"}`}
          aria-hidden
        />
        <span className="text-[11px] uppercase tracking-wide font-semibold text-ink-600">
          {label}
        </span>
      </div>
      <div className="text-xs text-ink-800 mt-1">{detail}</div>
    </div>
  );
}

// =====================================================================
// Quick actions
// =====================================================================

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
        <div className="absolute z-10 left-0 mt-1 w-72 rounded-lg border border-ink-200 bg-white shadow-lg p-3">
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
        Quick reschedule
      </div>
      <SchedulePresetsInput
        name="scheduled_at"
        defaultValueIso={defaultIso}
        timezoneLabel={timezoneLabel}
      />
      <SaveButton label="Save schedule" />
      {safe.error ? (
        <span className="block text-[11px] text-amber-700">{safe.error}</span>
      ) : null}
    </form>
  );
}

// =====================================================================
// Shared submit + helpers
// =====================================================================

function SaveButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="btn-primary text-xs disabled:opacity-60"
    >
      {pending ? "Saving…" : label}
    </button>
  );
}

function UploadButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="btn-ghost text-xs disabled:opacity-60"
    >
      {pending ? "Uploading…" : "Upload media"}
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
