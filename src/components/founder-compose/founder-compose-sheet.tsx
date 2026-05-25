"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  composeUpsertDraftAction,
  saveScheduleAction,
  sendForApprovalAction,
  uploadCreativeAssetAction,
  attachCreativeAction,
} from "@/app/(app)/weekly-plan/_actions";
import {
  SCHEDULE_PRESETS,
  toDatetimeLocalString,
} from "@/core/publishing/schedule-presets";
import { autosaveLabel, useAutosave } from "./use-autosave";
import {
  serializeAutosaveDraft,
  shouldResetDraft,
} from "./compose-autosave-helpers";
import {
  buildScheduleSavePayload,
  initialScheduleState,
  touchByClear,
  touchByInput,
  touchByPreset,
  type ScheduleSaveReason,
  type ScheduleState,
} from "./compose-schedule-save";
import { Markdown } from "./markdown";
import { RewriteChips } from "./rewrite-chips";

/**
 * Founder compose sheet — the "I had an idea" surface.
 *
 * Designed so the operator can:
 *   - open
 *   - type a title + body
 *   - pick a schedule preset
 *   - attach a creative (or skip)
 *   - send for approval
 * in under 60 seconds.
 *
 * Visible by default: title, body, schedule, creative. Everything
 * else (platform, subreddit, account, product, risk, notes) hides
 * behind "Show advanced".
 *
 * Mobile-first: full-screen on small viewports; centered modal on
 * desktop.
 */

export interface FounderComposeSheetDefaults {
  /** Workspace timezone label. */
  timezoneLabel: string | null;
  /** Auto-pick when there's exactly one confirmed Reddit account. */
  defaultAccountId: string | null;
  /** Auto-pick when there's exactly one confirmed product. */
  defaultProductId: string | null;
  /** First entry from ALLOWED_TEST_SUBREDDITS, defaults to "test". */
  defaultSubreddit: string;
  accounts: { id: string; displayName: string | null; platform: string }[];
  products: { id: string; name: string }[];
  allowedSubreddits: string[];
  /** F4.6 — true when an AI provider is configured server-side. */
  aiProviderAvailable?: boolean;
}

/**
 * Preloaded data for editing an existing item. When `existingItem`
 * is omitted, the sheet runs in create mode with smart defaults.
 */
export interface FounderComposeSheetExistingItem {
  itemId: string;
  title: string | null;
  body: string | null;
  platform: string | null;
  contentType: string | null;
  subreddit: string | null;
  accountId: string | null;
  productId: string | null;
  scheduledAtIso: string | null;
  riskScore: number | null;
  notes: string | null;
  creative: {
    id: string;
    assetUrl: string | null;
    altText: string | null;
    sourceType: string;
  } | null;
}

export interface FounderComposeSheetProps {
  open: boolean;
  onClose: () => void;
  defaults: FounderComposeSheetDefaults;
  /** When set, the sheet opens preloaded with this item's data and
   *  autosave writes back to the same row. */
  existingItem?: FounderComposeSheetExistingItem;
}

const PLATFORM_CHOICES: ReadonlyArray<{
  value: string;
  label: string;
  short: string;
}> = [
  { value: "reddit", label: "Reddit", short: "r/" },
  { value: "devto", label: "dev.to", short: "dev" },
  { value: "hashnode", label: "Hashnode", short: "Hn" },
  { value: "bluesky", label: "Bluesky", short: "Bs" },
];

interface DraftState {
  itemId: string | null;
  title: string;
  body: string;
  platform: string;
  contentType: string;
  subreddit: string;
  accountId: string;
  productId: string;
  riskScore: string;
  notes: string;
  creativeId: string | null;
  creativeAssetUrl: string | null;
  creativeAltText: string;
  // NOTE: schedule lives in its own state (ScheduleState). Body
  // autosaves cannot touch it; only the dedicated save path can.
}

function initialDraft(
  defaults: FounderComposeSheetDefaults,
  existing?: FounderComposeSheetExistingItem,
): DraftState {
  if (existing) {
    return {
      itemId: existing.itemId,
      title: existing.title ?? "",
      body: existing.body ?? "",
      platform: existing.platform ?? "reddit",
      contentType: existing.contentType ?? "post",
      subreddit: existing.subreddit ?? defaults.defaultSubreddit,
      accountId: existing.accountId ?? "",
      productId: existing.productId ?? "",
      riskScore: existing.riskScore === null ? "" : String(existing.riskScore),
      notes: existing.notes ?? "",
      creativeId: existing.creative?.id ?? null,
      creativeAssetUrl: existing.creative?.assetUrl ?? null,
      creativeAltText: existing.creative?.altText ?? "",
    };
  }
  return {
    itemId: null,
    title: "",
    body: "",
    platform: "reddit",
    contentType: "post",
    subreddit: defaults.defaultSubreddit,
    accountId: defaults.defaultAccountId ?? "",
    productId: defaults.defaultProductId ?? "",
    riskScore: "25",
    notes: "",
    creativeId: null,
    creativeAssetUrl: null,
    creativeAltText: "",
  };
}

/**
 * Compute the initial schedule snapshot for a modal opening.
 *
 * Edit mode: snapshot whatever the row has now (or empty). Touched=false.
 * Create mode: seed the operator-meaningful preset (tomorrow morning),
 * marked as touched so the explicit "Save schedule" fires once the
 * first draft save completes.
 */
function initialScheduleForOpen(
  existing?: FounderComposeSheetExistingItem,
): ScheduleState {
  if (existing) return initialScheduleState(existing.scheduledAtIso);
  const tomorrow9 = SCHEDULE_PRESETS.find(
    (p) => p.id === "tomorrow_morning",
  )!.resolve(new Date());
  const inputValue = toDatetimeLocalString(tomorrow9);
  return { inputValue, initialIso: null, touched: true };
}

export function FounderComposeSheet(props: FounderComposeSheetProps) {
  const router = useRouter();
  const [draft, setDraft] = useState<DraftState>(() =>
    initialDraft(props.defaults, props.existingItem),
  );
  const [schedule, setSchedule] = useState<ScheduleState>(() =>
    initialScheduleForOpen(props.existingItem),
  );
  const [scheduleSaveStatus, setScheduleSaveStatus] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [scheduleSaveError, setScheduleSaveError] = useState<string | null>(
    null,
  );
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [, startTransition] = useTransition();

  // Track the previous `open` value so we only reset on a real
  // closed → open transition. Parent re-renders that pass fresh
  // object literals for `defaults`/`existingItem` must NOT overwrite
  // in-progress edits.
  //
  // The schedule snapshot is FROZEN once the modal opens. Subsequent
  // parent refreshes (router.refresh, revalidatePath) cannot leak the
  // server-side stored ISO back into the input — only operator events
  // can touch it.
  const prevOpenRef = useRef(props.open);
  useEffect(() => {
    if (shouldResetDraft(prevOpenRef.current, props.open)) {
      setDraft(initialDraft(props.defaults, props.existingItem));
      setSchedule(initialScheduleForOpen(props.existingItem));
      setScheduleSaveStatus("idle");
      setScheduleSaveError(null);
      setShowAdvanced(false);
      setShowPreview(false);
    }
    prevOpenRef.current = props.open;
    // The deps list intentionally excludes `props.defaults` and
    // `props.existingItem` — they're snapshots captured at open
    // time. Object-identity changes to those props must NOT trigger
    // a re-reset mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  // ---- Body autosave (NEVER touches scheduled_at) ------------------
  const upsertRef = useRef<(d: DraftState) => Promise<{ ok: boolean; error?: string }>>(
    async () => ({ ok: false, error: "not_ready" }),
  );
  upsertRef.current = async (d: DraftState) => {
    const fd = new FormData();
    if (d.itemId) fd.set("item_id", d.itemId);
    fd.set("title", d.title);
    fd.set("body", d.body);
    fd.set("platform", d.platform);
    fd.set("content_type", d.contentType);
    fd.set("account_id", d.accountId);
    fd.set("product_id", d.productId);
    // INVARIANT: do NOT set "scheduled_at" here. Schedule writes have
    // a separate, explicit, operator-only path (saveScheduleAction).
    fd.set("subreddit", d.subreddit);
    if (d.riskScore.length > 0) fd.set("risk_score", d.riskScore);
    fd.set("notes", d.notes);
    const result = await composeUpsertDraftAction(
      { ok: false, error: "" },
      fd,
    );
    if (result.ok) {
      if (!d.itemId && result.itemId) {
        setDraft((cur) => ({ ...cur, itemId: result.itemId }));
      }
      return { ok: true };
    }
    return { ok: false, error: result.error ?? "Could not save." };
  };

  const autosave = useAutosave(draft, {
    serialize: (d) => serializeAutosaveDraft(d),
    enabled: (d) =>
      d.title.trim().length > 0 || d.body.trim().length > 0,
    delayMs: 1500,
    save: (d) => upsertRef.current(d),
  });

  // ---- Schedule save (operator-only, debounced) --------------------
  //
  // Fires only when `schedule.touched` is true. The reason is encoded
  // in `pendingScheduleReasonRef` and set by the operator-event
  // helpers (touchByInput / touchByPreset / touchByClear). Server
  // rejects writes without a recognized reason.
  const pendingScheduleReasonRef = useRef<ScheduleSaveReason | null>(null);
  const scheduleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedScheduleRef = useRef<string | null>(schedule.initialIso);

  async function runScheduleSave(
    snapshot: ScheduleState,
    reason: ScheduleSaveReason,
    itemId: string,
  ) {
    setScheduleSaveStatus("saving");
    setScheduleSaveError(null);
    try {
      const payload = buildScheduleSavePayload(snapshot, itemId, reason);
      if (!payload) {
        setScheduleSaveStatus("idle");
        return;
      }
      const fd = new FormData();
      fd.set("item_id", payload.itemId);
      fd.set("scheduled_at", payload.isoOrEmpty);
      fd.set("reason", payload.reason);
      if (process.env.NODE_ENV !== "production") {
        console.debug("[compose] saveScheduleAction", {
          reason,
          isoOrEmpty: payload.isoOrEmpty,
        });
      }
      const result = await saveScheduleAction(
        { ok: false, error: "" },
        fd,
      );
      if (result.ok) {
        lastSavedScheduleRef.current = result.scheduledAtIso;
        setScheduleSaveStatus("saved");
      } else {
        setScheduleSaveStatus("error");
        setScheduleSaveError(result.error ?? "Could not save schedule.");
      }
    } catch (err) {
      setScheduleSaveStatus("error");
      setScheduleSaveError(
        err instanceof Error ? err.message : "Could not save schedule.",
      );
    }
  }

  useEffect(() => {
    if (!schedule.touched) return;
    const reason = pendingScheduleReasonRef.current;
    if (!reason) return;
    // Need an item id before we can write. If the body autosave is
    // still creating the row, defer.
    if (!draft.itemId) return;
    const snapshot = schedule;
    if (scheduleTimerRef.current) clearTimeout(scheduleTimerRef.current);
    scheduleTimerRef.current = setTimeout(() => {
      void runScheduleSave(snapshot, reason, draft.itemId as string);
      pendingScheduleReasonRef.current = null;
    }, 600);
    return () => {
      if (scheduleTimerRef.current) clearTimeout(scheduleTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schedule.inputValue, schedule.touched, draft.itemId]);

  // ---- Actions -----------------------------------------------------
  async function handleClose() {
    await autosave.flushNow();
    props.onClose();
    startTransition(() => router.refresh());
  }

  async function handleSendForApproval() {
    await autosave.flushNow();
    if (!draft.itemId) return;
    const fd = new FormData();
    fd.set("item_id", draft.itemId);
    await sendForApprovalAction({ ok: false, error: "" }, fd);
    props.onClose();
    startTransition(() => router.refresh());
  }

  function applyPreset(presetId: string) {
    const preset = SCHEDULE_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    const resolved = preset.resolve(new Date());
    pendingScheduleReasonRef.current = "preset";
    setSchedule((s) => touchByPreset(s, toDatetimeLocalString(resolved)));
  }

  function handleScheduleInputChange(value: string) {
    pendingScheduleReasonRef.current = "input";
    setSchedule((s) => touchByInput(s, value));
  }

  function handleScheduleClear() {
    pendingScheduleReasonRef.current = "clear";
    setSchedule((s) => touchByClear(s));
  }

  if (!props.open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch md:items-center justify-center bg-ink-900/40"
      role="dialog"
      aria-modal="true"
    >
      {/* Backdrop click closes */}
      <button
        type="button"
        aria-label="Close compose"
        onClick={handleClose}
        className="absolute inset-0 cursor-default"
      />

      <div className="relative w-full md:max-w-2xl bg-white md:rounded-2xl md:my-8 md:max-h-[90vh] flex flex-col overflow-hidden md:shadow-2xl">
        {/* Sheet header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-ink-100 shrink-0">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-ink-900">
              {props.existingItem ? "Edit post" : "New post"}
            </div>
            <div className="text-[11px] text-ink-500 truncate">
              {autosaveLabel(autosave.status)}
              {autosave.errorMessage ? ` — ${autosave.errorMessage}` : ""}
            </div>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="btn-ghost text-xs"
          >
            Close
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-4 md:px-6 md:py-5 space-y-4">
          {/* Title */}
          <label className="block">
            <div className="flex items-baseline justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                Title
              </span>
              <CharCounter value={draft.title} limit={300} softAt={270} />
            </div>
            <input
              type="text"
              value={draft.title}
              onChange={(e) =>
                setDraft((d) => ({ ...d, title: e.target.value }))
              }
              placeholder="What's the hook?"
              className="input w-full text-lg mt-1"
              autoFocus={!props.existingItem}
            />
          </label>

          {/* Body — write / preview toggle, with markdown preview */}
          <div className="block">
            <div className="flex items-baseline justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                Body
              </span>
              <div className="flex items-center gap-2">
                <CharCounter value={draft.body} limit={10000} softAt={9000} />
                <button
                  type="button"
                  onClick={() => setShowPreview((v) => !v)}
                  className="text-[11px] text-ink-500 underline hover:text-ink-800"
                >
                  {showPreview ? "Write" : "Preview"}
                </button>
              </div>
            </div>
            {showPreview ? (
              <div className="mt-1 rounded-md border border-ink-200 bg-ink-50/40 px-3 py-2 min-h-[140px]">
                <Markdown source={draft.body} />
              </div>
            ) : (
              <textarea
                value={draft.body}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, body: e.target.value }))
                }
                placeholder="The post itself. Markdown supported."
                className="input w-full text-sm leading-relaxed mt-1 font-mono min-h-[140px] md:min-h-[200px]"
              />
            )}
            <p className="mt-1 text-[10px] text-ink-400 hidden md:block">
              Markdown supported: <span className="font-mono"># heading</span>{" "}
              · <span className="font-mono">**bold**</span> ·{" "}
              <span className="font-mono">*italic*</span> ·{" "}
              <span className="font-mono">[text](url)</span> · lists ·{" "}
              <span className="font-mono">```code```</span>
            </p>
          </div>

          {/* Editorial rewrite chips (F4.6 + F4.6.1 undo) */}
          <RewriteChips
            itemId={draft.itemId}
            providerAvailable={props.defaults.aiProviderAvailable ?? false}
            hasBody={draft.body.trim().length > 0}
            onApply={(patch) => {
              setDraft((d) => {
                const next = {
                  ...d,
                  ...(patch.title !== undefined ? { title: patch.title } : {}),
                  ...(patch.body !== undefined ? { body: patch.body } : {}),
                };
                // The server action already persisted these fields.
                // Mark them as saved so the autosave debounce doesn't
                // fire a redundant write right after the rewrite.
                autosave.markSaved(next);
                return next;
              });
            }}
          />

          {/* Platform — primary choice, chips not dropdown */}
          <div className="space-y-1.5">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
              Where
            </div>
            <div className="flex flex-wrap gap-1.5">
              {PLATFORM_CHOICES.map((p) => {
                const selected = draft.platform === p.value;
                return (
                  <button
                    key={p.value}
                    type="button"
                    onClick={() =>
                      setDraft((d) => ({ ...d, platform: p.value }))
                    }
                    className={`text-[11px] px-3 py-1 rounded-full border transition-colors inline-flex items-center gap-1.5 ${
                      selected
                        ? "bg-signal-50 border-signal-300 text-signal-800"
                        : "bg-white border-ink-200 text-ink-700 hover:bg-ink-50"
                    }`}
                  >
                    <span className="font-mono text-[10px] opacity-80">
                      {p.short}
                    </span>
                    {p.label}
                  </button>
                );
              })}
            </div>
            {draft.platform === "reddit" ? (
              <input
                type="text"
                value={draft.subreddit}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, subreddit: e.target.value }))
                }
                className="input w-full text-sm font-mono"
                placeholder="subreddit (e.g. test)"
                aria-label="Subreddit"
              />
            ) : null}
          </div>

          {/* Schedule */}
          <div className="space-y-1.5">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
              When
            </div>
            <div className="flex flex-wrap gap-1.5">
              {SCHEDULE_PRESETS.map((p) => {
                const matches = (() => {
                  if (!schedule.inputValue) return false;
                  const resolved = p.resolve(new Date());
                  return (
                    toDatetimeLocalString(resolved) === schedule.inputValue
                  );
                })();
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => applyPreset(p.id)}
                    className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${
                      matches
                        ? "bg-signal-50 border-signal-200 text-signal-800"
                        : "bg-white border-ink-200 text-ink-700 hover:bg-ink-50"
                    }`}
                    title={p.hint(new Date())}
                  >
                    {p.label}
                  </button>
                );
              })}
              {schedule.inputValue.length > 0 ? (
                <button
                  type="button"
                  onClick={handleScheduleClear}
                  className="text-[11px] px-2.5 py-1 rounded-full border bg-white border-ink-200 text-ink-500 hover:text-ink-800 hover:bg-ink-50"
                >
                  Clear
                </button>
              ) : null}
            </div>
            <input
              type="datetime-local"
              value={schedule.inputValue}
              onChange={(e) => handleScheduleInputChange(e.target.value)}
              className="input w-full text-sm font-mono"
            />
            <div className="text-[11px] text-ink-500 flex items-center justify-between gap-2">
              <span>
                {props.defaults.timezoneLabel
                  ? `Times shown in ${props.defaults.timezoneLabel}.`
                  : "Times shown in your browser timezone."}
              </span>
              <span className="tabular-nums">
                {scheduleSaveStatusLabel(scheduleSaveStatus)}
                {scheduleSaveError ? ` — ${scheduleSaveError}` : ""}
              </span>
            </div>
          </div>

          {/* Creative */}
          <CreativeRow
            draft={draft}
            setDraft={setDraft}
            ensureItemId={async () => {
              if (draft.itemId) return draft.itemId;
              await autosave.flushNow();
              return draft.itemId;
            }}
          />

          {/* Advanced */}
          <details
            open={showAdvanced}
            onToggle={(e) =>
              setShowAdvanced((e.target as HTMLDetailsElement).open)
            }
            className="rounded-md border border-ink-200"
          >
            <summary className="cursor-pointer text-xs text-ink-600 px-3 py-2 hover:bg-ink-50">
              Show advanced (account, product, risk, notes)
            </summary>
            <div className="px-3 py-3 space-y-2.5 text-xs">
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="text-ink-500">Account</span>
                  <select
                    value={draft.accountId}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, accountId: e.target.value }))
                    }
                    className="input w-full text-xs mt-0.5"
                  >
                    <option value="">—</option>
                    {props.defaults.accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {(a.displayName ?? a.id) + " · " + a.platform}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-ink-500">Product</span>
                  <select
                    value={draft.productId}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, productId: e.target.value }))
                    }
                    className="input w-full text-xs mt-0.5"
                  >
                    <option value="">—</option>
                    {props.defaults.products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-ink-500">Risk (0–100)</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={draft.riskScore}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, riskScore: e.target.value }))
                    }
                    className="input w-full text-xs mt-0.5"
                  />
                </label>
                <label className="block">
                  <span className="text-ink-500">Type</span>
                  <select
                    value={draft.contentType}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, contentType: e.target.value }))
                    }
                    className="input w-full text-xs mt-0.5"
                  >
                    <option value="post">Post</option>
                    <option value="comment">Comment (draft-only)</option>
                  </select>
                </label>
              </div>
              <label className="block">
                <span className="text-ink-500">Notes (private)</span>
                <textarea
                  rows={2}
                  value={draft.notes}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, notes: e.target.value }))
                  }
                  className="input w-full text-xs mt-0.5"
                />
              </label>
            </div>
          </details>
        </div>

        {/* Footer actions */}
        <div
          className="flex items-center justify-between gap-2 px-4 py-3 border-t border-ink-100 shrink-0 bg-white"
          style={{
            paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))",
          }}
        >
          <div className="text-[11px] text-ink-500">
            {autosaveLabel(autosave.status)}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleClose}
              className="btn-ghost text-xs"
            >
              Save as draft
            </button>
            <button
              type="button"
              onClick={handleSendForApproval}
              disabled={
                !draft.itemId ||
                draft.title.trim().length === 0 ||
                autosave.status === "saving"
              }
              className="btn-primary text-xs disabled:opacity-50"
            >
              Send for approval
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// =====================================================================
// Creative row — fast attach CTAs + skip
// =====================================================================

function CreativeRow({
  draft,
  setDraft,
  ensureItemId,
}: {
  draft: DraftState;
  setDraft: React.Dispatch<React.SetStateAction<DraftState>>;
  ensureItemId: () => Promise<string | null>;
}) {
  const [busy, setBusy] = useState<null | "upload" | "generate" | "url">(null);
  const [pasteUrl, setPasteUrl] = useState("");
  const [showPasteUrl, setShowPasteUrl] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function handleFile(file: File) {
    setBusy("upload");
    try {
      const itemId = await ensureItemId();
      if (!itemId) {
        setBusy(null);
        return;
      }
      const fd = new FormData();
      fd.set("item_id", itemId);
      if (draft.creativeId) fd.set("creative_id", draft.creativeId);
      fd.set("file", file);
      const result = await uploadCreativeAssetAction(
        { ok: false, error: "" },
        fd,
      );
      if (result.ok) {
        setDraft((d) => ({
          ...d,
          creativeId: result.creativeId,
          creativeAssetUrl: result.assetUrl,
        }));
      }
    } finally {
      setBusy(null);
    }
  }

  async function handleGenerateVisual() {
    setBusy("generate");
    try {
      const itemId = await ensureItemId();
      if (!itemId) {
        setBusy(null);
        return;
      }
      const prompt =
        draft.title.trim().length > 0
          ? `Clean founder visual for a post titled "${draft.title.trim()}". Calm, modern, build-in-public aesthetic.`
          : "Clean founder visual for a Reddit update post. Calm, modern, build-in-public aesthetic.";
      const fd = new FormData();
      fd.set("item_id", itemId);
      if (draft.creativeId) fd.set("creative_id", draft.creativeId);
      fd.set("creative_type", "image");
      fd.set("source_type", "generated");
      fd.set("prompt", prompt);
      fd.set("alt_text", draft.creativeAltText);
      const result = await attachCreativeAction(
        { ok: false, error: "" },
        fd,
      );
      if (result.ok) {
        setDraft((d) => ({
          ...d,
          creativeId: result.creativeId,
        }));
      }
    } finally {
      setBusy(null);
    }
  }

  async function handlePasteUrl() {
    if (!pasteUrl.trim()) return;
    setBusy("url");
    try {
      const itemId = await ensureItemId();
      if (!itemId) {
        setBusy(null);
        return;
      }
      const fd = new FormData();
      fd.set("item_id", itemId);
      if (draft.creativeId) fd.set("creative_id", draft.creativeId);
      fd.set("creative_type", "image");
      fd.set("source_type", "manual_url");
      fd.set("source_url", pasteUrl.trim());
      fd.set("asset_url", pasteUrl.trim());
      fd.set("alt_text", draft.creativeAltText);
      const result = await attachCreativeAction(
        { ok: false, error: "" },
        fd,
      );
      if (result.ok) {
        setDraft((d) => ({
          ...d,
          creativeId: result.creativeId,
          creativeAssetUrl: pasteUrl.trim(),
        }));
        setShowPasteUrl(false);
        setPasteUrl("");
      }
    } finally {
      setBusy(null);
    }
  }

  const hasCreative = Boolean(draft.creativeId);

  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
        Creative
      </div>

      {draft.creativeAssetUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={draft.creativeAssetUrl}
          alt={draft.creativeAltText || ""}
          className="max-h-40 rounded-md border border-ink-200 object-contain"
        />
      ) : hasCreative ? (
        <div className="rounded-md border border-dashed border-ink-300 bg-ink-50/50 px-3 py-2 text-[11px] text-ink-600">
          Creative planned — operator will attach the asset later.
        </div>
      ) : null}

      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (f) {
            await handleFile(f);
            if (fileRef.current) fileRef.current.value = "";
          }
        }}
      />

      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy !== null}
          className="text-[11px] px-2.5 py-1 rounded-full border bg-white border-ink-200 text-ink-700 hover:bg-ink-50 disabled:opacity-50"
        >
          {busy === "upload" ? "Uploading…" : "Upload screenshot / image / video"}
        </button>
        <button
          type="button"
          onClick={() => setShowPasteUrl((v) => !v)}
          className="text-[11px] px-2.5 py-1 rounded-full border bg-white border-ink-200 text-ink-700 hover:bg-ink-50"
        >
          Paste URL
        </button>
        <button
          type="button"
          onClick={handleGenerateVisual}
          disabled={busy !== null}
          className="text-[11px] px-2.5 py-1 rounded-full border bg-white border-ink-200 text-ink-700 hover:bg-ink-50 disabled:opacity-50"
        >
          {busy === "generate" ? "Planning…" : "Generate visual"}
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft((d) => ({ ...d, creativeId: null, creativeAssetUrl: null }));
          }}
          className="text-[11px] px-2.5 py-1 text-ink-500 hover:text-ink-800"
        >
          {hasCreative ? "Remove" : "Skip for now"}
        </button>
      </div>

      {showPasteUrl ? (
        <div className="flex items-center gap-1.5">
          <input
            type="url"
            placeholder="https://..."
            value={pasteUrl}
            onChange={(e) => setPasteUrl(e.target.value)}
            className="input flex-1 text-xs font-mono"
          />
          <button
            type="button"
            onClick={handlePasteUrl}
            disabled={busy !== null || pasteUrl.trim().length === 0}
            className="btn-ghost text-xs disabled:opacity-50"
          >
            {busy === "url" ? "Saving…" : "Attach"}
          </button>
        </div>
      ) : null}

      {hasCreative ? (
        <AltTextEditor
          itemId={draft.itemId}
          creativeId={draft.creativeId}
          altText={draft.creativeAltText}
          onAltTextChange={(text) =>
            setDraft((d) => ({ ...d, creativeAltText: text }))
          }
        />
      ) : null}
    </div>
  );
}

// =====================================================================
// Alt text editor — explicit save status, clears blocker on save
// =====================================================================
//
// Saves on blur and on Cmd/Ctrl+Enter. Shows status next to the
// label so the operator can tell the save succeeded. Schedule state
// is never touched here.

function AltTextEditor({
  itemId,
  creativeId,
  altText,
  onAltTextChange,
}: {
  itemId: string | null;
  creativeId: string | null;
  altText: string;
  onAltTextChange: (text: string) => void;
}) {
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const lastSavedRef = useRef<string>(altText);

  async function commit() {
    if (!itemId || !creativeId) return;
    const trimmed = altText.trim();
    if (trimmed === lastSavedRef.current.trim()) return;
    if (trimmed.length === 0) return;
    setStatus("saving");
    setError(null);
    const fd = new FormData();
    fd.set("item_id", itemId);
    fd.set("creative_id", creativeId);
    fd.set("creative_type", "image");
    fd.set("source_type", "uploaded");
    fd.set("alt_text", trimmed);
    const result = await attachCreativeAction({ ok: false, error: "" }, fd);
    if (result.ok) {
      lastSavedRef.current = trimmed;
      setStatus("saved");
    } else {
      setStatus("error");
      setError(result.error ?? "Could not save alt text.");
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] text-ink-500">
          Alt text {altText.trim().length === 0 ? "(required before publish)" : ""}
        </span>
        <span className="text-[10px] tabular-nums text-ink-400">
          {status === "saving"
            ? "Saving alt text…"
            : status === "saved"
              ? "Alt text saved"
              : status === "error"
                ? `Alt text not saved — ${error ?? ""}`
                : altText.trim().length > 0
                  ? "Unsaved changes"
                  : ""}
        </span>
      </div>
      <input
        type="text"
        value={altText}
        onChange={(e) => onAltTextChange(e.target.value)}
        placeholder="Describe the image for accessibility."
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void commit();
          }
        }}
        className="input w-full text-xs mt-0.5"
      />
    </div>
  );
}

// =====================================================================
// Schedule save status label
// =====================================================================

function scheduleSaveStatusLabel(
  status: "idle" | "saving" | "saved" | "error",
): string {
  switch (status) {
    case "idle":
      return "Schedule unchanged";
    case "saving":
      return "Saving schedule…";
    case "saved":
      return "Schedule saved";
    case "error":
      return "Schedule not saved";
  }
}

// =====================================================================
// Character counter
// =====================================================================
//
// Soft warning only — never blocks typing. Reddit imposes the hard
// limit at submit time; we just give the operator a heads-up so they
// don't run into "title too long" mid-publish.

function CharCounter({
  value,
  limit,
  softAt,
}: {
  value: string;
  limit: number;
  softAt: number;
}) {
  const n = value.length;
  const over = n > limit;
  const warn = n >= softAt && n <= limit;
  return (
    <span
      className={`text-[10px] tabular-nums ${
        over ? "text-red-700" : warn ? "text-amber-700" : "text-ink-400"
      }`}
      title={
        over
          ? `Over the ${limit}-char limit; the platform will refuse the submit.`
          : warn
            ? `Approaching the ${limit}-char limit.`
            : `${n}/${limit} characters used`
      }
    >
      {n} / {limit}
    </span>
  );
}
