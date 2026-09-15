"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import type { LinkedInSequenceStepKind } from "@/lib/supabase/types";
import { MAX_SEQUENCE_STEPS, SELECTABLE_STEP_KINDS, STEP_KIND_LABELS } from "@/core/linkedin-sales/state";
import { createSequenceAction, type CreateSequenceResult } from "../_actions";

const EMPTY: CreateSequenceResult = { ok: false, error: "" };

interface StepDraft {
  key: number;
  kind: LinkedInSequenceStepKind;
  waitDays: number;
  template: string;
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn-primary min-h-11 w-full sm:w-auto" disabled={pending}>
      {pending ? "Saving…" : "Save sequence"}
    </button>
  );
}

export function SequenceForm() {
  const [state, dispatch] = useFormState(createSequenceAction, EMPTY);
  const [steps, setSteps] = useState<StepDraft[]>([{ key: 1, kind: "manual_connection_request", waitDays: 0, template: "" }]);
  const [nextKey, setNextKey] = useState(2);

  const update = (key: number, patch: Partial<StepDraft>) =>
    setSteps((s) => s.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  const remove = (key: number) => setSteps((s) => s.filter((x) => x.key !== key));
  const add = () => {
    if (steps.length >= MAX_SEQUENCE_STEPS) return;
    setSteps((s) => [...s, { key: nextKey, kind: "wait", waitDays: 2, template: "" }]);
    setNextKey((k) => k + 1);
  };

  return (
    <form action={dispatch} className="card card-padded space-y-4" aria-labelledby="new-sequence-heading">
      <h3 id="new-sequence-heading" className="section-title">New sequence</h3>
      <p className="text-sm text-ink-600 leading-relaxed">
        Each step becomes a task for you, in order, with a wait between them if you add one. Drafts may use{" "}
        <code>{"{{name}}"}</code>, <code>{"{{company}}"}</code> and <code>{"{{title}}"}</code>; you copy the result
        yourself when the task is ready.
      </p>
      <label className="block text-sm max-w-md">
        <span className="block font-medium text-ink-800 mb-1">Name</span>
        <input name="name" required maxLength={120} className="input w-full min-h-11" />
      </label>

      <ol className="list-none p-0 m-0 space-y-3">
        {steps.map((step, i) => (
          <li key={step.key}>
            <fieldset className="border border-ink-200 rounded-md p-3 space-y-3">
              <legend className="text-sm font-medium text-ink-800 px-1">Step {i + 1}</legend>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="block text-sm">
                  <span className="block font-medium text-ink-800 mb-1">What you will do</span>
                  <select
                    name={`step_kind_${i + 1}`}
                    value={step.kind}
                    onChange={(e) => update(step.key, { kind: e.target.value as LinkedInSequenceStepKind })}
                    className="input w-full min-h-11"
                  >
                    {SELECTABLE_STEP_KINDS.map((k) => (
                      <option key={k} value={k}>{STEP_KIND_LABELS[k]}</option>
                    ))}
                  </select>
                </label>
                {step.kind === "wait" ? (
                  <label className="block text-sm">
                    <span className="block font-medium text-ink-800 mb-1">Days to wait</span>
                    <input
                      type="number"
                      name={`step_wait_${i + 1}`}
                      min={0}
                      max={365}
                      value={step.waitDays}
                      onChange={(e) => update(step.key, { waitDays: Number(e.target.value) })}
                      className="input w-full min-h-11"
                    />
                  </label>
                ) : null}
              </div>
              {step.kind !== "wait" ? (
                <label className="block text-sm">
                  <span className="block font-medium text-ink-800 mb-1">
                    {step.kind === "manual_profile_review" ? "Notes for yourself (optional)" : step.kind === "internal_note" ? "Note" : "Draft you will copy"}
                  </span>
                  <textarea
                    name={`step_template_${i + 1}`}
                    rows={3}
                    maxLength={4000}
                    value={step.template}
                    onChange={(e) => update(step.key, { template: e.target.value })}
                    className="input w-full"
                  />
                </label>
              ) : null}
              <button type="button" onClick={() => remove(step.key)} className="btn-secondary min-h-11 w-full sm:w-auto" disabled={steps.length === 1}>
                Remove step {i + 1}
              </button>
            </fieldset>
          </li>
        ))}
      </ol>
      <div className="flex flex-col sm:flex-row flex-wrap gap-2">
        <button type="button" onClick={add} className="btn-secondary min-h-11 w-full sm:w-auto" disabled={steps.length >= MAX_SEQUENCE_STEPS}>
          Add a step
        </button>
        <Submit />
      </div>
      {state.error ? <p role="alert" className="text-sm text-red-700">{state.error}</p> : null}
      {state.ok ? <p role="status" className="text-sm text-green-800">Sequence saved.</p> : null}
    </form>
  );
}
