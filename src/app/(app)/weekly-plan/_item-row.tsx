"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import {
  attachCreativeAction,
  updatePlanItemAction,
  type AttachCreativeResult,
  type UpdatePlanItemResult,
} from "./_actions";

const updateInitial: UpdatePlanItemResult = { ok: false, error: "" };
const creativeInitial: AttachCreativeResult = { ok: false, error: "" };

export interface PlanItemRowProps {
  id: string;
  title: string | null;
  body: string | null;
  platform: string | null;
  contentType: string | null;
  productId: string | null;
  accountId: string | null;
  scheduledAt: string | null;
  status: string;
  riskScore: number | null;
  riskLevel: string | null;
  notes: string | null;
  statusLabel: string;
  statusBadgeClass: string;
  isPost: boolean;
  warnings: string[];
  products: { id: string; name: string }[];
  accounts: {
    id: string;
    displayName: string | null;
    platform: string;
  }[];
  creative: {
    id: string;
    creativeType: string;
    sourceType: string;
    sourceUrl: string | null;
    assetUrl: string | null;
    prompt: string | null;
    altText: string | null;
    license: string | null;
    attribution: string | null;
    riskNotes: string | null;
    status: string;
  } | null;
  creativeBadge: { label: string; cls: string };
}

function toDatetimeLocal(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function PlanItemRow(props: PlanItemRowProps) {
  const [editing, setEditing] = useState(false);
  const [showCreative, setShowCreative] = useState(false);

  return (
    <li className="px-5 py-4 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-medium text-ink-900 truncate">
            {props.title ?? "Untitled"}
          </div>
          <div className="text-xs text-ink-500 mt-0.5">
            {props.platform ?? "—"}
            {props.contentType ? ` · ${props.contentType}` : ""}
            {props.scheduledAt
              ? ` · ${new Date(props.scheduledAt).toLocaleString()}`
              : " · no schedule"}
          </div>
          {props.body ? (
            <p className="text-xs text-ink-700 mt-1 line-clamp-2">
              {props.body}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className={`${props.statusBadgeClass} text-[10px]`}>
            {props.statusLabel}
          </span>
          {props.isPost ? (
            <span className={`${props.creativeBadge.cls} text-[10px]`}>
              {props.creativeBadge.label}
            </span>
          ) : (
            <span className="badge-neutral text-[10px]">draft-only</span>
          )}
        </div>
      </div>

      {props.warnings.length > 0 ? (
        <ul className="text-[11px] text-amber-700 leading-relaxed space-y-0.5">
          {props.warnings.map((w, i) => (
            <li key={i}>· {w}</li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          className="btn-ghost text-xs"
        >
          {editing ? "Close edit" : "Edit"}
        </button>
        {props.isPost ? (
          <button
            type="button"
            onClick={() => setShowCreative((v) => !v)}
            className="btn-ghost text-xs"
          >
            {showCreative
              ? "Close creative"
              : props.creative
                ? "Edit creative"
                : "Attach creative"}
          </button>
        ) : null}
      </div>

      {editing ? (
        <EditForm
          itemId={props.id}
          title={props.title ?? ""}
          body={props.body ?? ""}
          platform={props.platform ?? ""}
          contentType={props.contentType ?? "post"}
          productId={props.productId ?? ""}
          accountId={props.accountId ?? ""}
          scheduledAt={toDatetimeLocal(props.scheduledAt)}
          status={props.status}
          riskScore={props.riskScore}
          notes={props.notes ?? ""}
          products={props.products}
          accounts={props.accounts}
          onSaved={() => setEditing(false)}
        />
      ) : null}

      {showCreative && props.isPost ? (
        <CreativeForm
          itemId={props.id}
          creative={props.creative}
          onSaved={() => setShowCreative(false)}
        />
      ) : null}
    </li>
  );
}

function EditForm(props: {
  itemId: string;
  title: string;
  body: string;
  platform: string;
  contentType: string;
  productId: string;
  accountId: string;
  scheduledAt: string;
  status: string;
  riskScore: number | null;
  notes: string;
  products: { id: string; name: string }[];
  accounts: { id: string; displayName: string | null; platform: string }[];
  onSaved: () => void;
}) {
  const [state, formAction] = useFormState(
    updatePlanItemAction,
    updateInitial,
  );
  const safe = state ?? updateInitial;
  if (safe.ok && safe.itemId === props.itemId) {
    // Auto-close on success
    queueMicrotask(props.onSaved);
  }
  return (
    <form
      action={formAction}
      className="rounded-md border border-ink-200 p-3 bg-ink-50/50 grid grid-cols-1 md:grid-cols-2 gap-3"
    >
      <input type="hidden" name="item_id" value={props.itemId} />
      <label className="block md:col-span-2 text-xs">
        <div className="font-semibold text-ink-700 mb-1">Title</div>
        <input
          name="title"
          defaultValue={props.title}
          className="input w-full text-sm"
        />
      </label>
      <label className="block md:col-span-2 text-xs">
        <div className="font-semibold text-ink-700 mb-1">Body</div>
        <textarea
          name="body"
          rows={4}
          defaultValue={props.body}
          className="input w-full text-sm"
        />
      </label>
      <label className="block text-xs">
        <div className="font-semibold text-ink-700 mb-1">Platform</div>
        <select
          name="platform"
          defaultValue={props.platform}
          className="input w-full text-sm"
        >
          <option value="">—</option>
          <option value="reddit">Reddit</option>
          <option value="x">X</option>
          <option value="linkedin">LinkedIn</option>
          <option value="google">Google</option>
        </select>
      </label>
      <label className="block text-xs">
        <div className="font-semibold text-ink-700 mb-1">Content type</div>
        <select
          name="content_type"
          defaultValue={props.contentType}
          className="input w-full text-sm"
        >
          <option value="post">post</option>
          <option value="comment">comment (draft-only)</option>
        </select>
      </label>
      <label className="block text-xs">
        <div className="font-semibold text-ink-700 mb-1">Product</div>
        <select
          name="product_id"
          defaultValue={props.productId}
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
      <label className="block text-xs">
        <div className="font-semibold text-ink-700 mb-1">Account</div>
        <select
          name="account_id"
          defaultValue={props.accountId}
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
        <div className="font-semibold text-ink-700 mb-1">
          Scheduled at (workspace time)
        </div>
        <input
          type="datetime-local"
          name="scheduled_at"
          defaultValue={props.scheduledAt}
          className="input w-full text-sm"
        />
      </label>
      <label className="block text-xs">
        <div className="font-semibold text-ink-700 mb-1">Risk score (0–100)</div>
        <input
          type="number"
          name="risk_score"
          min={0}
          max={100}
          defaultValue={props.riskScore ?? ""}
          className="input w-full text-sm"
        />
      </label>
      <label className="block text-xs">
        <div className="font-semibold text-ink-700 mb-1">Status</div>
        <select
          name="status"
          defaultValue={
            props.status === "draft" ||
            props.status === "pending_approval" ||
            props.status === "skipped"
              ? props.status
              : ""
          }
          className="input w-full text-sm"
        >
          <option value="">— keep current —</option>
          <option value="draft">draft</option>
          <option value="pending_approval">pending_approval</option>
          <option value="skipped">skipped</option>
        </select>
      </label>
      <label className="block text-xs md:col-span-2">
        <div className="font-semibold text-ink-700 mb-1">
          Operator notes (private, stored in metadata)
        </div>
        <textarea
          name="notes"
          rows={2}
          defaultValue={props.notes}
          className="input w-full text-sm"
        />
      </label>
      <div className="md:col-span-2 flex items-center gap-3">
        <SaveButton label="Save changes" />
        {safe.ok ? (
          <span className="text-[11px] text-emerald-700">Saved.</span>
        ) : safe.error ? (
          <span className="text-[11px] text-amber-700">{safe.error}</span>
        ) : null}
      </div>
    </form>
  );
}

function CreativeForm(props: {
  itemId: string;
  creative: PlanItemRowProps["creative"];
  onSaved: () => void;
}) {
  const [state, formAction] = useFormState(
    attachCreativeAction,
    creativeInitial,
  );
  const safe = state ?? creativeInitial;
  if (safe.ok && safe.creativeId) {
    queueMicrotask(props.onSaved);
  }
  const c = props.creative;
  return (
    <form
      action={formAction}
      className="rounded-md border border-ink-200 p-3 bg-ink-50/50 grid grid-cols-1 md:grid-cols-2 gap-3"
    >
      <input type="hidden" name="item_id" value={props.itemId} />
      {c ? <input type="hidden" name="creative_id" value={c.id} /> : null}

      <div className="md:col-span-2 text-[11px] text-ink-600 leading-relaxed">
        Every publishable post needs one creative. Allowed sources:
        operator-uploaded, AI-generated (with prompt), Wikimedia / public-domain /
        CC (with attribution &amp; license), official product screenshot, or
        an explicit URL with license notes. <span className="font-semibold">
        Do not use random Google images, Pinterest, or unclear-copyright
        stock.</span>
      </div>

      <label className="block text-xs">
        <div className="font-semibold text-ink-700 mb-1">Creative type</div>
        <select
          name="creative_type"
          defaultValue={c?.creativeType ?? "image"}
          className="input w-full text-sm"
        >
          <option value="image">image</option>
          <option value="video">video</option>
          <option value="animation">animation</option>
        </select>
      </label>
      <label className="block text-xs">
        <div className="font-semibold text-ink-700 mb-1">Source</div>
        <select
          name="source_type"
          defaultValue={c?.sourceType ?? "planned"}
          className="input w-full text-sm"
        >
          <option value="planned">planned (placeholder)</option>
          <option value="generated">generated</option>
          <option value="uploaded">uploaded</option>
          <option value="wikimedia">wikimedia / CC / public-domain</option>
          <option value="official_source">official source</option>
          <option value="manual_url">manual URL (with license)</option>
        </select>
      </label>

      <label className="block text-xs md:col-span-2">
        <div className="font-semibold text-ink-700 mb-1">
          Prompt (for generated creatives)
        </div>
        <textarea
          name="prompt"
          rows={2}
          defaultValue={c?.prompt ?? ""}
          className="input w-full text-sm"
        />
      </label>

      <label className="block text-xs">
        <div className="font-semibold text-ink-700 mb-1">Source URL</div>
        <input
          name="source_url"
          defaultValue={c?.sourceUrl ?? ""}
          placeholder="https://commons.wikimedia.org/…"
          className="input w-full text-sm font-mono"
        />
      </label>
      <label className="block text-xs">
        <div className="font-semibold text-ink-700 mb-1">Asset URL (final)</div>
        <input
          name="asset_url"
          defaultValue={c?.assetUrl ?? ""}
          placeholder="Final file URL once uploaded"
          className="input w-full text-sm font-mono"
        />
      </label>

      <label className="block text-xs md:col-span-2">
        <div className="font-semibold text-ink-700 mb-1">
          Alt text (required before publish)
        </div>
        <input
          name="alt_text"
          defaultValue={c?.altText ?? ""}
          className="input w-full text-sm"
        />
      </label>

      <label className="block text-xs">
        <div className="font-semibold text-ink-700 mb-1">License</div>
        <input
          name="license"
          defaultValue={c?.license ?? ""}
          placeholder="CC-BY-4.0, Public Domain, ©, …"
          className="input w-full text-sm"
        />
      </label>
      <label className="block text-xs">
        <div className="font-semibold text-ink-700 mb-1">Attribution</div>
        <input
          name="attribution"
          defaultValue={c?.attribution ?? ""}
          placeholder="by Jane Doe via Wikimedia Commons"
          className="input w-full text-sm"
        />
      </label>

      <label className="block text-xs md:col-span-2">
        <div className="font-semibold text-ink-700 mb-1">Risk notes</div>
        <textarea
          name="risk_notes"
          rows={2}
          defaultValue={c?.riskNotes ?? ""}
          className="input w-full text-sm"
        />
      </label>

      <div className="md:col-span-2 flex items-center gap-3">
        <SaveButton label={c ? "Save creative" : "Attach creative"} />
        {safe.ok ? (
          <span className="text-[11px] text-emerald-700">Saved.</span>
        ) : safe.error ? (
          <span className="text-[11px] text-amber-700">{safe.error}</span>
        ) : null}
      </div>
    </form>
  );
}

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
