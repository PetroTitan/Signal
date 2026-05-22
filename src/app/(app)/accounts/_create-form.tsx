"use client";

import { useFormState, useFormStatus } from "react-dom";
import {
  createAccountAction,
  type AccountActionState,
} from "./_actions";

const initial: AccountActionState = { ok: false, error: null };

interface AccountCreateFormProps {
  products: { id: string; name: string }[];
}

export function AccountCreateForm({ products }: AccountCreateFormProps) {
  const [state, formAction] = useFormState(createAccountAction, initial);

  return (
    <section className="card p-5">
      <h2 className="text-sm font-semibold text-ink-900">Add an account</h2>
      <p className="text-xs text-ink-600 mt-1 leading-relaxed">
        Connect through official OAuth when integrations are enabled. For
        now, accounts are saved as <span className="font-mono">not_connected</span>.
      </p>

      <form
        action={formAction}
        className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3"
      >
        <label className="block">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
            Platform
          </div>
          <select name="platform" required className="input w-full">
            <option value="">Pick a platform</option>
            <option value="reddit">Reddit</option>
            <option value="x">X</option>
            <option value="linkedin">LinkedIn</option>
            <option value="google">Google (discoverability)</option>
          </select>
        </label>
        <label className="block">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
            Role
          </div>
          <select name="role" className="input w-full">
            <option value="">—</option>
            <option value="founder">Founder</option>
            <option value="team">Team</option>
            <option value="support">Support</option>
          </select>
        </label>
        <label className="block">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
            Display name
          </div>
          <input
            type="text"
            name="display_name"
            required
            className="input w-full"
          />
        </label>
        <label className="block">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
            Handle (optional)
          </div>
          <input
            type="text"
            name="handle"
            placeholder="@yourhandle"
            className="input w-full font-mono text-xs"
          />
        </label>
        <label className="block md:col-span-2">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
            Product (optional)
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

        {state.error ? (
          <div
            role="alert"
            className="md:col-span-2 text-xs leading-relaxed rounded-md px-3 py-2 bg-amber-50 text-amber-800"
          >
            {state.error}
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
      {pending ? "Saving…" : "Add account"}
    </button>
  );
}
