"use client";
/**
 * The final confirmation before Signal begins unfollowing people.
 *
 * WHY THE FORM DOES NOT EXIST UNTIL THE LAST STATE
 * -----------------------------------------------
 * "Cancelling must produce zero server-action calls" is easy to claim
 * and easy to break — a stray `onClick` that dispatches before the
 * dialog resolves, a form that submits on Enter, a handler that fires
 * on unmount. So the guarantee here is STRUCTURAL rather than
 * behavioural: the `<form action={dispatch}>` exists only while the
 * dialog is open AND no terminal result has been shown, and the only
 * control that submits it is the confirm button.
 *
 * Every cancellation path — the Cancel button, Escape, the backdrop,
 * navigating away, the component unmounting — clears the same piece of
 * state, which unmounts the only form that could dispatch. There is no
 * code path from any of them to a server action, because after any of
 * them there is no form.
 *
 * WHY A NATIVE <dialog>
 * ---------------------
 * `showModal()` gives a focus trap, Escape-to-close, background
 * inertness and the correct accessibility tree for free. Hand-rolling
 * those is where modal accessibility usually goes wrong.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is not authorization. Confirming proves a human clicked; it proves
 * nothing about who they are or what they may do. The server action
 * behind it re-runs the full gate — authenticated user, workspace
 * membership, `connect_platforms`, the campaign's kind and status, the
 * import job's completeness, a live session, and the typed handle
 * matching the session's ACTUAL handle — and trusts nothing this
 * component sends.
 */

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";

export interface ActivationFacts {
  campaignId: string;
  /** The Bluesky identity every deletion will be performed as. */
  actorLabel: string;
  /** The handle the operator must type back, without the @. */
  actorHandle: string;
  sourceLabel: string;
  /** Null when the count is not yet knowable. */
  discovered: number | null;
  stillBuilding: boolean;
  protectedExcluded: number;
  remainingEligible: number;
  requestedDailyQuota: number;
  effectiveDailyQuota: number;
  effectiveQuotaReason: string | null;
  timezone: string;
  windowLabel: string;
  estimatedDays: number | null;
  dryRun: boolean;
}

function ConfirmButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="btn-danger-solid min-h-11 w-full sm:w-auto"
      disabled={pending || disabled}
    >
      {pending ? "Starting…" : "Start automatic unfollowing"}
    </button>
  );
}

const PHRASE = "start automatic unfollowing";

export function ConfirmActivationDialog(props: {
  facts: ActivationFacts | null;
  dispatch: (formData: FormData) => void;
  onCancel: () => void;
  /**
   * Set once the action has produced a terminal outcome. While this is
   * non-null the dialog is a RESULT, not a prompt: the form is gone, so
   * the same campaign cannot be started twice by pressing again.
   */
  result?: { ok: boolean; message: string } | null;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const { facts, onCancel } = props;
  const result = props.result ?? null;
  const [typedPhrase, setTypedPhrase] = useState("");
  const [typedHandle, setTypedHandle] = useState("");

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (facts && !node.open) {
      // showModal, not show: only the modal form traps focus and makes
      // the rest of the page inert.
      node.showModal();
    } else if (!facts && node.open) {
      node.close();
    }
  }, [facts]);

  // Escape and the backdrop both fire `cancel` on the element itself,
  // so the parent's state is cleared through the SAME path as the
  // Cancel button rather than a second, divergent one.
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const handle = (event: Event) => {
      event.preventDefault();
      onCancel();
    };
    node.addEventListener("cancel", handle);
    return () => node.removeEventListener("cancel", handle);
  }, [onCancel]);

  // Unmount is a cancellation too. A navigation mid-confirmation must
  // leave nothing behind that could still dispatch.
  useEffect(() => () => { ref.current?.close(); }, []);

  useEffect(() => {
    if (!facts) {
      setTypedPhrase("");
      setTypedHandle("");
    }
  }, [facts]);

  if (!facts) {
    // Rendered closed and EMPTY: no form exists, so nothing can submit.
    return <dialog ref={ref} className="hidden" aria-hidden="true" />;
  }

  const handleMatches =
    typedHandle.trim().replace(/^@/, "").toLowerCase() ===
    facts.actorHandle.toLowerCase();
  const phraseMatches = typedPhrase.trim().toLowerCase() === PHRASE;
  const ready = handleMatches && phraseMatches && !facts.stillBuilding;

  return (
    <dialog
      ref={ref}
      aria-labelledby="unfollow-confirm-title"
      aria-describedby="unfollow-confirm-effect"
      className="p-0 bg-transparent backdrop:bg-ink-900/40 max-w-lg w-[calc(100vw-2rem)]"
    >
      <div className="card card-padded space-y-4 text-left max-h-[85vh] overflow-y-auto">
        <div>
          <h2
            id="unfollow-confirm-title"
            className="text-base font-semibold text-ink-900"
          >
            Start automatic unfollowing?
          </h2>
          <p className="text-sm text-ink-600 mt-1 leading-relaxed">
            Acting as{" "}
            <span className="font-medium text-ink-900 break-all">
              {facts.actorLabel}
            </span>
            .
          </p>
        </div>

        <p
          id="unfollow-confirm-effect"
          className="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-md p-3 leading-relaxed"
        >
          Unfollowing is <strong>public account state</strong>. Each one
          deletes a follow record on Bluesky and may affect a real person.
          Signal cannot undo it — re-following is a new, separate action.
        </p>

        <dl className="text-sm grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
          <div>
            <dt className="stat-label">Source</dt>
            <dd className="text-ink-900 break-words">{facts.sourceLabel}</dd>
          </div>
          <div>
            <dt className="stat-label">Profiles found</dt>
            <dd className="text-ink-900">
              {facts.stillBuilding ? (
                <span className="text-amber-800">
                  Still building the list
                  {facts.discovered !== null
                    ? ` — ${facts.discovered.toLocaleString()} so far`
                    : ""}
                </span>
              ) : (
                (facts.discovered ?? 0).toLocaleString()
              )}
            </dd>
          </div>
          <div>
            <dt className="stat-label">Protected / excluded</dt>
            <dd className="text-ink-900">
              {facts.protectedExcluded.toLocaleString()}
            </dd>
          </div>
          <div>
            <dt className="stat-label">Will be unfollowed</dt>
            <dd className="text-ink-900 font-medium">
              {facts.remainingEligible.toLocaleString()}
            </dd>
          </div>
          <div>
            <dt className="stat-label">You asked for</dt>
            <dd className="text-ink-900">
              {facts.requestedDailyQuota.toLocaleString()} a day
            </dd>
          </div>
          <div>
            <dt className="stat-label">Signal will do at most</dt>
            <dd className="text-ink-900">
              {facts.effectiveDailyQuota.toLocaleString()} a day
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="stat-label">Time of day</dt>
            <dd className="text-ink-900 break-words">
              {facts.windowLabel} ({facts.timezone})
            </dd>
          </div>
        </dl>

        {facts.effectiveQuotaReason ? (
          <p className="text-sm text-ink-700 bg-ink-50 border border-ink-200 rounded-md p-3 leading-relaxed">
            {facts.effectiveQuotaReason}
          </p>
        ) : null}

        <p className="text-sm text-ink-600 leading-relaxed">
          {facts.estimatedDays !== null ? (
            <>
              <strong>Estimated {facts.estimatedDays.toLocaleString()} days.</strong>{" "}
              This is an estimate, not a promise: what Signal may do each day is
              recalculated daily from this account&rsquo;s remaining allowance and
              anything Bluesky tells us.
            </>
          ) : (
            "How long this takes cannot be estimated yet."
          )}
        </p>

        <p className="text-sm text-ink-600 leading-relaxed">
          Pausing or cancelling stops future work.{" "}
          <strong>It does not re-follow anyone already unfollowed.</strong>
        </p>

        {facts.dryRun ? (
          <p className="text-sm text-sky-900 bg-sky-50 border border-sky-200 rounded-md p-3 leading-relaxed">
            <strong>Dry run.</strong> Signal will go through every step and send
            nothing to Bluesky. No follow record will be deleted.
          </p>
        ) : null}

        {result ? (
          <p
            className={`text-sm leading-relaxed border rounded-md p-3 ${
              result.ok
                ? "text-emerald-900 bg-emerald-50 border-emerald-200"
                : "text-red-900 bg-red-50 border-red-200"
            }`}
            role="status"
          >
            {result.message}
          </p>
        ) : null}

        {result ? (
          // TERMINAL. The form is not rendered at all, so the same
          // campaign cannot be started a second time — there is no
          // submit control left in the tree to press.
          <div className="flex justify-end">
            <button
              type="button"
              className="btn-primary min-h-11 w-full sm:w-auto"
              onClick={onCancel}
            >
              Close
            </button>
          </div>
        ) : (
          <>
            <div className="space-y-3">
              <label className="block">
                <span className="stat-label">
                  Type the handle this will act as
                </span>
                <input
                  type="text"
                  inputMode="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={typedHandle}
                  onChange={(e) => setTypedHandle(e.target.value)}
                  placeholder={facts.actorHandle}
                  aria-label="Confirm the Bluesky handle"
                  className="input mt-1 w-full min-h-11"
                />
              </label>
              <label className="block">
                <span className="stat-label">
                  Type <span className="font-mono">{PHRASE}</span>
                </span>
                <input
                  type="text"
                  inputMode="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={typedPhrase}
                  onChange={(e) => setTypedPhrase(e.target.value)}
                  aria-label="Type the confirmation phrase"
                  className="input mt-1 w-full min-h-11"
                />
              </label>
            </div>

            <div className="flex flex-col-reverse sm:flex-row sm:flex-wrap gap-2 sm:justify-end">
              {/* Cancel is a plain button inside no form of its own. It
                  clears the parent's state, which unmounts the form
                  below — there is no path from here to a dispatch. */}
              <button
                type="button"
                className="btn-secondary min-h-11 w-full sm:w-auto"
                onClick={onCancel}
              >
                Cancel
              </button>
              <form action={props.dispatch} className="w-full sm:w-auto">
                <input
                  type="hidden"
                  name="campaign_id"
                  value={facts.campaignId}
                />
                {/* Sent only when both fields match. The server checks
                    both again and does not trust either. */}
                <input type="hidden" name="confirm" value={PHRASE} />
                <input
                  type="hidden"
                  name="confirm_identity"
                  value={typedHandle.trim().replace(/^@/, "")}
                />
                <ConfirmButton disabled={!ready} />
              </form>
            </div>
          </>
        )}
      </div>
    </dialog>
  );
}
