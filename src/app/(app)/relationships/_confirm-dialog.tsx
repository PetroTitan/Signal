"use client";
/**
 * Confirmation step for irreversible, externally-visible relationship
 * actions.
 *
 * WHY THE FORM LIVES INSIDE THE DIALOG
 * ------------------------------------
 * "Cancel must produce zero server-action and provider calls" is easy
 * to claim and easy to break — a stray `onClick` that dispatches before
 * the dialog resolves, a form that submits on Enter, a confirm handler
 * that fires on unmount. So the guarantee is structural rather than
 * behavioural: the `<form action={dispatch}>` **only exists inside this
 * dialog**, and the only control that submits it is the confirm button.
 * The trigger in the toolbar is a plain `type="button"` that sets state.
 * There is no code path from Cancel to a dispatch, because Cancel
 * unmounts the only form that could dispatch.
 *
 * WHY A NATIVE <dialog>
 * ---------------------
 * `showModal()` gives a focus trap, Escape-to-close, background inertness
 * and the correct accessibility tree for free. Hand-rolling those is
 * where modal accessibility usually goes wrong — a hand-rolled trap that
 * misses Shift+Tab, or an Escape handler bound to the wrong node. The
 * element is labelled and described explicitly so a screen reader
 * announces what is about to happen, not just "dialog".
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It is not authorization. Confirming here proves a human clicked; it
 * proves nothing about who they are or what they may do. Every action
 * behind it re-runs the full server-side gate — authenticated user,
 * workspace membership, `connect_platforms`, identity ownership, batch
 * size — and none of that trusts anything this component sends.
 */

import { useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";

export type ConfirmKind = "follow" | "unfollow" | "remove_target";

export interface ConfirmRequest {
  kind: ConfirmKind;
  /** The Bluesky identity the action runs as, already formatted. */
  actorLabel: string;
  /** Hidden fields posted with the action. Repeated keys are allowed. */
  fields: { name: string; value: string }[];
  /** Human-readable labels for what will be acted on, for review. */
  itemLabels: string[];
  /** Accounts removed from the selection because they are protected. */
  protectedExcluded: number;
}

const COPY: Record<
  ConfirmKind,
  { title: (n: number) => string; verb: string; effect: string }
> = {
  follow: {
    title: (n) => (n === 1 ? "Follow 1 account?" : `Follow ${n} accounts?`),
    verb: "Follow",
    effect:
      "This creates a public follow on Bluesky. The accounts will be notified, and anyone can see it.",
  },
  unfollow: {
    title: (n) => (n === 1 ? "Unfollow 1 account?" : `Unfollow ${n} accounts?`),
    verb: "Unfollow",
    effect:
      "This deletes the follow record on Bluesky. Signal cannot undo it — re-following is a new, separate action.",
  },
  remove_target: {
    title: () => "Remove this target profile?",
    verb: "Remove target",
    effect:
      "This removes the target and its import progress from Signal. Candidates already imported are kept, and no relationship on Bluesky changes.",
  },
};

/** The confirm button. Separate so `useFormStatus` sees the right form. */
function ConfirmButton({ kind }: { kind: ConfirmKind }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={kind === "follow" ? "btn-primary" : "btn-danger-solid"}
      disabled={pending}
    >
      {pending ? "Working…" : COPY[kind].verb}
    </button>
  );
}

export function ConfirmActionDialog(props: {
  request: ConfirmRequest | null;
  /** The `useFormState` dispatcher for the action being confirmed. */
  dispatch: (formData: FormData) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const { request, onCancel } = props;

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (request && !node.open) {
      // showModal, not show: only the modal form traps focus and makes
      // the rest of the page inert.
      node.showModal();
    } else if (!request && node.open) {
      node.close();
    }
  }, [request]);

  // Escape and the backdrop both fire `cancel`/`close` on the element
  // itself, so the parent's state is cleared through the same path as
  // the Cancel button rather than a second, divergent one.
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

  if (!request) {
    // Rendered closed and empty: no form exists, so nothing can submit.
    return <dialog ref={ref} className="hidden" aria-hidden="true" />;
  }

  const copy = COPY[request.kind];
  const count = request.itemLabels.length;
  const preview = request.itemLabels.slice(0, 5);
  const overflow = count - preview.length;

  return (
    <dialog
      ref={ref}
      aria-labelledby="confirm-title"
      aria-describedby="confirm-effect"
      className="p-0 bg-transparent backdrop:bg-ink-900/40 max-w-md w-[calc(100vw-2rem)]"
    >
      <div className="card card-padded space-y-4 text-left">
        <div>
          <h2 id="confirm-title" className="text-base font-semibold text-ink-900">
            {copy.title(count)}
          </h2>
          <p className="text-sm text-ink-600 mt-1 leading-relaxed">
            Acting as{" "}
            <span className="font-medium text-ink-900 break-all">
              {request.actorLabel}
            </span>
            .
          </p>
        </div>

        <p
          id="confirm-effect"
          className="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-md p-3 leading-relaxed"
        >
          {copy.effect}
        </p>

        {preview.length > 0 ? (
          <div>
            <h3 className="section-title">
              {request.kind === "remove_target" ? "Target" : `${count} selected`}
            </h3>
            <ul className="list-none p-0 m-0 mt-2 space-y-1">
              {preview.map((label, i) => (
                <li key={`${label}-${i}`} className="text-sm text-ink-800 break-all">
                  {label}
                </li>
              ))}
              {overflow > 0 ? (
                <li className="text-sm text-ink-500">and {overflow} more</li>
              ) : null}
            </ul>
          </div>
        ) : null}

        {request.protectedExcluded > 0 ? (
          <p className="text-sm text-ink-700 leading-relaxed">
            <span className="badge-info">Protected</span>{" "}
            {request.protectedExcluded} selected{" "}
            {request.protectedExcluded === 1 ? "account is" : "accounts are"}{" "}
            excluded and will not be unfollowed.
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2 justify-end">
          {/* Cancel is a plain button inside no form of its own. It
              clears the parent's state, which unmounts the form below —
              there is no path from here to a dispatch. */}
          <button type="button" className="btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <form action={props.dispatch}>
            {request.fields.map((f, i) => (
              <input
                key={`${f.name}-${i}`}
                type="hidden"
                name={f.name}
                value={f.value}
              />
            ))}
            <ConfirmButton kind={request.kind} />
          </form>
        </div>
      </div>
    </dialog>
  );
}
