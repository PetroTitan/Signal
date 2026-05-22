"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { ALLOWED_AI_USE_CASES, USE_CASE_LABELS, type AiUseCase } from "@/core/ai";
import {
  MOCK_MEMORY_SNAPSHOT,
  MockMemoryRetriever,
  TOKEN_BUDGETS,
  assembleContext,
  estimateObjectTokens,
  type AssembledContext,
} from "@/core/memory";
import type { MemoryEntityKind, MemoryRetrievalResult } from "@/types/memory";

const KIND_LABELS: Record<MemoryEntityKind, string> = {
  workspace: "Workspace",
  platform: "Platform",
  product: "Product",
  account: "Account",
  historical_pattern: "Historical pattern",
  risk: "Risk",
  ai_preference: "AI preference",
  blocked_phrase: "Blocked phrase",
};

interface InventoryRow {
  kind: MemoryEntityKind;
  count: number;
  estimatedTokens: number;
}

function buildInventory(): InventoryRow[] {
  const s = MOCK_MEMORY_SNAPSHOT;
  const groups: Record<MemoryEntityKind, unknown[]> = {
    workspace: s.workspaces.filter((x) => x.active),
    platform: s.platforms.filter((x) => x.active),
    product: s.products.filter((x) => x.active),
    account: s.accounts.filter((x) => x.active),
    historical_pattern: s.patterns.filter((x) => x.active),
    risk: s.risks.filter((x) => x.active),
    ai_preference: s.aiPreferences.filter((x) => x.active),
    blocked_phrase: s.blockedPhrases.filter((x) => x.active),
  };
  return (Object.keys(groups) as MemoryEntityKind[]).map((kind) => {
    const items = groups[kind];
    const tokens = items.reduce<number>(
      (sum, it) => sum + estimateObjectTokens(it),
      0,
    );
    return { kind, count: items.length, estimatedTokens: tokens };
  });
}

export default function AiMemoryDebugPage() {
  const [taskType, setTaskType] = useState<AiUseCase>("rewrite_softer");
  const [retrieval, setRetrieval] = useState<MemoryRetrievalResult | null>(null);
  const [assembled, setAssembled] = useState<AssembledContext | null>(null);

  const inventory = useMemo(buildInventory, []);
  const totalEntities = inventory.reduce((s, r) => s + r.count, 0);
  const totalTokens = inventory.reduce((s, r) => s + r.estimatedTokens, 0);
  const budget = TOKEN_BUDGETS[taskType];

  async function preview() {
    const retriever = new MockMemoryRetriever(MOCK_MEMORY_SNAPSHOT);
    const r = await retriever.retrieve({
      taskType,
      workspaceId: "ws_helperg",
      platform: "reddit",
      tokenBudget: budget.maxTokens,
    });
    const a = assembleContext({ taskType, retrieval: r });
    setRetrieval(r);
    setAssembled(a);
  }

  return (
    <>
      <Topbar
        title="AI memory"
        description="Internal debug. Memory inventory, retrieval preview, and token budget."
      />

      <div className="px-6 lg:px-10 py-8 max-w-4xl space-y-6">
        <p className="text-xs text-ink-500 leading-relaxed">
          Signal does not send giant prompts. The retriever ranks and caps memory
          by task token budget before any context reaches a model.{" "}
          <Link href="/settings" className="underline">
            Back to settings
          </Link>
          .
        </p>

        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">
            Active memory entities
          </h2>
          <div className="mt-1 text-xs text-ink-500">
            {totalEntities} entities · ~{totalTokens} tokens total
          </div>
          <ul className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1 text-sm">
            {inventory.map((row) => (
              <li
                key={row.kind}
                className="flex items-center justify-between border-b border-ink-100 py-1.5"
              >
                <span className="text-ink-800">{KIND_LABELS[row.kind]}</span>
                <span className="text-xs text-ink-500 font-mono">
                  {row.count} · ~{row.estimatedTokens}t
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">
            Retrieval preview
          </h2>
          <p className="text-xs text-ink-500 mt-1 leading-relaxed">
            Deterministic. No model calls. Same query returns the same items.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label className="text-xs text-ink-600">Task</label>
            <select
              value={taskType}
              onChange={(e) => {
                setTaskType(e.target.value as AiUseCase);
                setRetrieval(null);
                setAssembled(null);
              }}
              className="text-xs border border-ink-200 rounded-md px-2 py-1"
            >
              {ALLOWED_AI_USE_CASES.map((u) => (
                <option key={u} value={u}>
                  {USE_CASE_LABELS[u]}
                </option>
              ))}
            </select>
            <span className="text-xs text-ink-500 font-mono">
              budget {budget.maxTokens}t
            </span>
            <button type="button" className="btn" onClick={preview}>
              Run retrieval
            </button>
          </div>

          {retrieval ? (
            <div className="mt-4 space-y-3">
              <div className="text-xs text-ink-600">
                {retrieval.items.length} items · ~{retrieval.totalEstimatedTokens}
                {"t "}
                {retrieval.truncated ? "· truncated to fit budget" : "· within budget"}
              </div>
              <ul className="text-xs text-ink-700 divide-y divide-ink-100 rounded-md border border-ink-100">
                {retrieval.items.map((it) => (
                  <li
                    key={`${it.kind}-${it.id}`}
                    className="flex items-center justify-between px-3 py-1.5"
                  >
                    <span>
                      <span className="font-mono text-ink-500 mr-2">
                        {KIND_LABELS[it.kind]}
                      </span>
                      {it.id}
                    </span>
                    <span className="font-mono text-ink-500">
                      rel {it.relevance.toFixed(2)} · ~{it.estimatedTokens}t
                    </span>
                  </li>
                ))}
              </ul>
              <div className="text-[11px] text-ink-500">
                Sources:{" "}
                {retrieval.sources
                  .map((s) => `${KIND_LABELS[s.kind]} (${s.count})`)
                  .join(" · ")}
              </div>
            </div>
          ) : (
            <div className="mt-4 text-xs text-ink-500">
              Pick a task and run retrieval to see the ranked memory and
              assembled context preview.
            </div>
          )}
        </section>

        {assembled ? (
          <section className="card p-5">
            <h2 className="text-sm font-semibold text-ink-900">
              Assembled context
            </h2>
            <div className="mt-1 text-xs text-ink-500">
              ~{assembled.estimatedTokens}t of {assembled.budget.maxTokens}t budget ·{" "}
              {assembled.layers.length} layers ·{" "}
              {assembled.truncated ? "truncated" : "fits"}
            </div>
            {assembled.warning ? (
              <div className="mt-2 text-xs text-amber-700">
                {assembled.warning}
              </div>
            ) : null}
            <ul className="mt-4 space-y-2">
              {assembled.layers.map((l, i) => (
                <li
                  key={`${l.kind}-${i}`}
                  className="rounded-md border border-ink-100 p-2.5"
                >
                  <div className="flex items-center justify-between text-[11px] text-ink-500 font-mono">
                    <span>{l.kind}</span>
                    <span>~{l.estimatedTokens}t</span>
                  </div>
                  <pre className="text-xs text-ink-700 whitespace-pre-wrap mt-1 font-mono">
                    {l.content}
                  </pre>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="card p-5 text-xs text-ink-600 leading-relaxed">
          <div className="font-semibold text-ink-900 mb-1">
            Why this stays minimal
          </div>
          Signal never sends the entire workspace, history, or all comments to a
          model. The retriever caps every prompt by task-specific token budget;
          context is assembled from compressed entities only.
        </section>
      </div>
    </>
  );
}
