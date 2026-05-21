"use client";

import { useMemo } from "react";
import { useSignal } from "@/core/store";
import { platformLoad, accountWeeklyCount } from "@/core/scheduler";
import type { PlatformId } from "@/types";

type CalloutKind = "info" | "warn" | "block";

interface CalloutLine {
  kind: CalloutKind;
  text: string;
}

export function CadenceCallout() {
  const lines = useCadenceMessages();
  if (lines.length === 0) return null;
  return (
    <div className="space-y-2">
      {lines.map((line, i) => (
        <CalloutLine key={i} kind={line.kind} text={line.text} />
      ))}
    </div>
  );
}

function CalloutLine({ kind, text }: CalloutLine) {
  const tones: Record<CalloutKind, string> = {
    info: "border-signal-200 bg-signal-50/40 text-ink-800",
    warn: "border-amber-200 bg-amber-50/50 text-ink-800",
    block: "border-red-200 bg-red-50/50 text-ink-900",
  };
  const dotTones: Record<CalloutKind, string> = {
    info: "bg-signal-500",
    warn: "bg-amber-500",
    block: "bg-red-600",
  };
  return (
    <div className={`card ${tones[kind]} flex items-start gap-3 p-3.5 text-sm`}>
      <span
        className={`inline-block h-2 w-2 rounded-full mt-1.5 shrink-0 ${dotTones[kind]}`}
      />
      <div className="leading-relaxed">{text}</div>
    </div>
  );
}

export function useCadenceMessages(): CalloutLine[] {
  const { state } = useSignal();

  return useMemo(() => {
    const out: CalloutLine[] = [];
    const load = platformLoad(state.items);
    const platforms: PlatformId[] = ["reddit", "x", "linkedin"];
    for (const p of platforms) {
      const info = load[p];
      if (info.isOver) {
        out.push({
          kind: "warn",
          text: `You already scheduled enough ${labelFor(p)} content this week (${info.count} of ${info.suggested} suggested). Signal will hold further items in the backlog.`,
        });
      } else if (info.isApproachingMax) {
        out.push({
          kind: "warn",
          text: `${labelFor(p)} is approaching its weekly cap. New items will likely be deferred.`,
        });
      }
    }

    for (const account of Object.values(state.accountsById)) {
      const weekly = accountWeeklyCount(account.id, state.items);
      if (weekly >= 4) {
        out.push({
          kind: "warn",
          text: `${account.displayName} has ${weekly} items this week — recommended cooldown: 48 hours between posts.`,
        });
      }
      if (
        (account.status === "planned" ||
          account.status === "setup_needed" ||
          account.status === "awaiting_manual_creation") &&
        state.items.some((i) => i.accountId === account.id)
      ) {
        out.push({
          kind: "block",
          text: `${account.displayName} is still in setup. Items on this account should be moved to the backlog until the account is connected.`,
        });
      }
    }

    if (state.lastMoves.length > 0) {
      out.push({
        kind: "info",
        text: `${state.lastMoves.length} item${state.lastMoves.length === 1 ? "" : "s"} were moved to safer windows during the last redistribution.`,
      });
    }

    return out.slice(0, 4);
  }, [state.items, state.accountsById, state.lastMoves]);
}

function labelFor(p: PlatformId): string {
  return p === "x" ? "X" : p === "reddit" ? "Reddit" : "LinkedIn";
}
