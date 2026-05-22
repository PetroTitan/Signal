"use client";

import { useEffect, useRef } from "react";
import { useFormState, useFormStatus } from "react-dom";
import {
  createExecutionQueueAction,
  type CreateQueueResult,
} from "./_actions";

const initial: CreateQueueResult = { ok: false, error: "" };

export function CreateQueueForm() {
  const [state, formAction] = useFormState(createExecutionQueueAction, initial);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state?.ok) formRef.current?.reset();
  }, [state]);

  const safe = state ?? initial;

  return (
    <section className="card p-5">
      <h2 className="text-sm font-semibold text-ink-900">Create execution queue</h2>
      <p className="text-xs text-ink-600 mt-1 leading-relaxed">
        A queue groups execution items under your active contract. Queueing,
        authorization, and dry-run all happen inside it.
      </p>
      <form ref={formRef} action={formAction} className="mt-4 flex flex-col md:flex-row gap-3">
        <input
          type="text"
          name="title"
          defaultValue="This week's queue"
          required
          className="input flex-1"
          placeholder="Queue title"
        />
        <Submit />
      </form>
      {!safe.ok && safe.error ? (
        <p className="text-xs text-red-700 mt-2">{safe.error}</p>
      ) : null}
    </section>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn-primary text-sm" disabled={pending}>
      {pending ? "Creating…" : "Create queue"}
    </button>
  );
}
