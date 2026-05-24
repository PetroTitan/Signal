"use client";

import { useEffect, useRef, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import {
  createOperatorTokenAction,
  type CreateTokenResult,
} from "./_actions";
import { buildSnippets } from "@/mcp/snippets";
import type { FounderPermissionGroup } from "@/mcp/founder-permissions";

const initial: CreateTokenResult = { ok: false, error: "" };

const ASSISTANT_OPTIONS: ReadonlyArray<{
  value: string;
  label: string;
}> = [
  { value: "Claude Code", label: "Claude Code" },
  { value: "Codex", label: "Codex" },
  { value: "Claude Opus", label: "Claude Opus" },
  { value: "Custom", label: "Custom" },
];

const EXPIRATION_OPTIONS: ReadonlyArray<{
  value: string;
  label: string;
}> = [
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "never", label: "Never" },
];

interface CreateTokenFormProps {
  endpoint: string;
  groups: ReadonlyArray<FounderPermissionGroup>;
}

export function CreateTokenForm({ endpoint, groups }: CreateTokenFormProps) {
  const [state, action] = useFormState(createOperatorTokenAction, initial);
  const formRef = useRef<HTMLFormElement>(null);
  const [assistantLabel, setAssistantLabel] = useState<string>("Claude Code");
  const [expiration, setExpiration] = useState<string>("90d");
  const [selectedGroups, setSelectedGroups] = useState<string[]>(() =>
    groups.filter((g) => g.defaultChecked).map((g) => g.key),
  );

  useEffect(() => {
    if (state?.ok && formRef.current) {
      formRef.current.reset();
      setAssistantLabel("Claude Code");
      setExpiration("90d");
      setSelectedGroups(
        groups.filter((g) => g.defaultChecked).map((g) => g.key),
      );
    }
  }, [state, groups]);

  const safe = state ?? initial;

  function toggleGroup(key: string) {
    setSelectedGroups((prev) =>
      prev.includes(key) ? prev.filter((g) => g !== key) : [...prev, key],
    );
  }

  return (
    <section className="rounded-2xl border border-ink-200 bg-white p-5 space-y-4">
      <header>
        <h2 className="text-sm font-semibold text-ink-900">
          Connect an assistant
        </h2>
        <p className="text-xs text-ink-600 mt-1 leading-relaxed">
          Create a token, paste the snippet into Claude Code or Codex, and
          the assistant can prepare work in this workspace. Publishing
          still requires your approval.
        </p>
      </header>

      <form ref={formRef} action={action} className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="block">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
              Token name
            </div>
            <input
              type="text"
              name="name"
              required
              placeholder="e.g. Claude Code — MacBook Pro"
              maxLength={200}
              className="input w-full text-sm"
            />
          </label>
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
              Assistant
            </div>
            <div className="flex flex-wrap gap-1.5">
              {ASSISTANT_OPTIONS.map((opt) => {
                const selected = assistantLabel === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setAssistantLabel(opt.value)}
                    className={`text-[11px] px-3 py-1 rounded-full border transition-colors ${
                      selected
                        ? "bg-signal-50 border-signal-300 text-signal-800"
                        : "bg-white border-ink-200 text-ink-700 hover:bg-ink-50"
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
            <input
              type="hidden"
              name="assistant_label"
              value={assistantLabel}
            />
          </div>
        </div>

        <fieldset>
          <legend className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
            What the assistant can do
          </legend>
          <div className="mt-2 space-y-2">
            {groups.map((group) => {
              const checked = selectedGroups.includes(group.key);
              return (
                <label
                  key={group.key}
                  className="flex items-start gap-3 rounded-md border border-ink-200 bg-white px-3 py-2 cursor-pointer hover:bg-ink-50"
                >
                  <input
                    type="checkbox"
                    name="permission_groups"
                    value={group.key}
                    checked={checked}
                    onChange={() => toggleGroup(group.key)}
                    className="mt-0.5 shrink-0"
                  />
                  <div className="min-w-0">
                    <div className="text-sm text-ink-900">{group.label}</div>
                    <div className="text-[11px] text-ink-500 leading-relaxed mt-0.5">
                      {group.description}
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
            Expiration
          </div>
          <div className="flex flex-wrap gap-1.5">
            {EXPIRATION_OPTIONS.map((opt) => {
              const selected = expiration === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setExpiration(opt.value)}
                  className={`text-[11px] px-3 py-1 rounded-full border transition-colors ${
                    selected
                      ? "bg-signal-50 border-signal-300 text-signal-800"
                      : "bg-white border-ink-200 text-ink-700 hover:bg-ink-50"
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          <input type="hidden" name="expiration" value={expiration} />
        </div>

        <SubmitButton />

        {safe.error ? (
          <p className="text-xs text-amber-700">{safe.error}</p>
        ) : null}
      </form>

      {safe.ok ? (
        <TokenReceipt
          endpoint={endpoint}
          plaintext={safe.plaintext}
          tokenPreview={safe.tokenPreview}
          assistantLabel={safe.assistantLabel ?? "Custom"}
          expiresAt={safe.expiresAt}
        />
      ) : null}
    </section>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="btn-primary text-sm disabled:opacity-50"
    >
      {pending ? "Creating…" : "Create token"}
    </button>
  );
}

function TokenReceipt({
  endpoint,
  plaintext,
  tokenPreview,
  assistantLabel,
  expiresAt,
}: {
  endpoint: string;
  plaintext: string;
  tokenPreview: string;
  assistantLabel: string;
  expiresAt: string | null;
}) {
  const snippets = buildSnippets({ endpoint, token: plaintext });
  const tabs: Array<{ key: string; label: string; body: string }> = [
    { key: "claude_code", label: "Claude Code", body: snippets.claudeCode },
    { key: "codex", label: "Codex", body: snippets.codex },
    { key: "generic", label: "Other MCP client", body: snippets.generic },
    { key: "curl", label: "curl test", body: snippets.curlSmokeTest },
  ];
  const [activeTab, setActiveTab] = useState(tabs[0].key);
  const activeBody = tabs.find((t) => t.key === activeTab)?.body ?? "";

  return (
    <div className="rounded-2xl border border-emerald-200 bg-emerald-50/40 p-4 space-y-3">
      <div>
        <div className="text-sm font-semibold text-emerald-900">
          Token created — copy it now
        </div>
        <p className="text-xs text-emerald-900/80 mt-1 leading-relaxed">
          This is the only time you&apos;ll see the full token. Signal
          stores only its hash. {assistantLabel} can read this workspace
          once the snippet is in place.
          {expiresAt
            ? ` Expires ${new Date(expiresAt).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}.`
            : " Never expires."}
        </p>
      </div>

      <div className="space-y-2">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
            Endpoint
          </div>
          <div className="flex items-center gap-2">
            <code className="font-mono text-[11px] text-ink-800 bg-white border border-ink-200 rounded px-2 py-1 flex-1 break-all">
              {endpoint}
            </code>
            <CopyMicroButton label="Copy" value={endpoint} />
          </div>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
            Bearer token ({tokenPreview}…)
          </div>
          <div className="flex items-center gap-2">
            <code className="font-mono text-[11px] text-ink-800 bg-white border border-ink-200 rounded px-2 py-1 flex-1 break-all">
              {plaintext}
            </code>
            <CopyMicroButton label="Copy" value={plaintext} />
          </div>
        </div>
      </div>

      <div>
        <div className="flex flex-wrap gap-1.5 border-b border-emerald-100">
          {tabs.map((t) => {
            const active = activeTab === t.key;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setActiveTab(t.key)}
                className={`text-[11px] px-2.5 py-1 -mb-px border-b-2 transition-colors ${
                  active
                    ? "border-emerald-600 text-emerald-900"
                    : "border-transparent text-ink-600 hover:text-ink-900"
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>
        <div className="mt-2 relative">
          <pre className="font-mono text-[11px] text-ink-800 bg-white border border-ink-200 rounded-md p-3 overflow-x-auto whitespace-pre">
            {activeBody}
          </pre>
          <div className="absolute top-2 right-2">
            <CopyMicroButton label="Copy" value={activeBody} />
          </div>
        </div>
      </div>
    </div>
  );
}

function CopyMicroButton({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      disabled={value.length === 0}
      className="text-[10px] px-2 py-1 rounded border border-ink-200 bg-white text-ink-700 hover:bg-ink-50 disabled:opacity-50"
    >
      {copied ? "✓" : label}
    </button>
  );
}
