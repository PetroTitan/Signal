"use client";

import { useEffect, useRef } from "react";
import { useFormState, useFormStatus } from "react-dom";
import {
  createPlanItemAction,
  type CreatePlanItemResult,
} from "./_actions";

const initial: CreatePlanItemResult = { ok: false, error: "" };

interface CreateItemFormProps {
  products: { id: string; name: string }[];
  accounts: { id: string; displayName: string | null; platform: string }[];
}

export function CreateItemForm({ products, accounts }: CreateItemFormProps) {
  const [state, formAction] = useFormState(createPlanItemAction, initial);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state?.ok) {
      formRef.current?.reset();
    }
  }, [state]);

  const safe = state ?? initial;

  return (
    <section className="card p-5">
      <h2 className="text-sm font-semibold text-ink-900">Add an item</h2>
      <p className="text-xs text-ink-600 mt-1 leading-relaxed">
        Items land in the current week as <span className="font-mono">pending_approval</span>.
        Approve them from the approval queue.
      </p>
      <form
        ref={formRef}
        action={formAction}
        className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3"
      >
        <label className="block md:col-span-2">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
            Title / hook
          </div>
          <input
            type="text"
            name="title"
            required
            className="input w-full"
          />
        </label>
        <label className="block md:col-span-2">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
            Body (optional)
          </div>
          <textarea name="body" rows={3} className="input w-full" />
        </label>
        <label className="block">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
            Platform
          </div>
          <select name="platform" className="input w-full">
            <option value="">—</option>
            <option value="reddit">Reddit</option>
            <option value="x">X</option>
            <option value="linkedin">LinkedIn</option>
            <option value="google">Google</option>
          </select>
        </label>
        <label className="block">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
            Content type
          </div>
          <input
            type="text"
            name="content_type"
            placeholder="discussion_post, comment_reply, …"
            className="input w-full font-mono text-xs"
          />
        </label>
        <label className="block">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
            Product
          </div>
          <select name="product_id" className="input w-full">
            <option value="">—</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
            Account
          </div>
          <select name="account_id" className="input w-full">
            <option value="">—</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {(a.displayName ?? a.id) + " · " + a.platform}
              </option>
            ))}
          </select>
        </label>

        {safe.ok ? (
          <div
            role="status"
            className="md:col-span-2 text-xs leading-relaxed rounded-md px-3 py-2 bg-emerald-50 text-emerald-800"
          >
            Added. Open the approval queue to review.
          </div>
        ) : safe.error ? (
          <div
            role="alert"
            className="md:col-span-2 text-xs leading-relaxed rounded-md px-3 py-2 bg-amber-50 text-amber-800"
          >
            {safe.error}
          </div>
        ) : null}

        <div className="md:col-span-2">
          <SubmitButton />
        </div>
      </form>
    </section>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="btn-primary disabled:opacity-60"
    >
      {pending ? "Adding…" : "Add item"}
    </button>
  );
}
