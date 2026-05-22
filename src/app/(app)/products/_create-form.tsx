"use client";

import { useEffect, useRef } from "react";
import { useFormState, useFormStatus } from "react-dom";
import {
  createProductAction,
  type CreateProductResult,
} from "./_actions";

const initial: CreateProductResult = { ok: false, error: "" };

export function ProductCreateForm() {
  const [state, formAction] = useFormState(createProductAction, initial);
  const formRef = useRef<HTMLFormElement>(null);

  // After a successful submit, reset the inputs so the form is ready
  // for the next product. The list above re-renders automatically via
  // revalidatePath in the server action.
  useEffect(() => {
    if (state?.ok) {
      formRef.current?.reset();
    }
  }, [state]);

  // Defensive: in pathological cases (action thrown unexpectedly) state
  // could be undefined. Treat that as a no-op state.
  const safe = state ?? initial;

  return (
    <section className="card p-5">
      <h2 className="text-sm font-semibold text-ink-900">Add a product</h2>
      <p className="text-xs text-ink-600 mt-1 leading-relaxed">
        Name and category are enough to start. You can refine the profile
        later.
      </p>
      <form
        ref={formRef}
        action={formAction}
        className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3"
      >
        <label className="block md:col-span-2">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
            Name
          </div>
          <input
            type="text"
            name="name"
            required
            placeholder="Acme Insights"
            className="input w-full"
          />
        </label>
        <label className="block">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
            Domain
          </div>
          <input
            type="text"
            name="domain"
            placeholder="example.com"
            className="input w-full font-mono text-xs"
          />
        </label>
        <label className="block">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
            Category
          </div>
          <input
            type="text"
            name="category"
            placeholder="analytics, productivity, etc."
            className="input w-full"
          />
        </label>
        <label className="block md:col-span-2">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
            Short summary
          </div>
          <textarea
            name="summary"
            rows={3}
            placeholder="What the product does, in one or two sentences."
            className="input w-full"
          />
        </label>

        {safe.ok ? (
          <div
            role="status"
            className="md:col-span-2 text-xs leading-relaxed rounded-md px-3 py-2 bg-emerald-50 text-emerald-800"
          >
            Product added. It shows in the list above.
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
      {pending ? "Creating…" : "Create product"}
    </button>
  );
}
