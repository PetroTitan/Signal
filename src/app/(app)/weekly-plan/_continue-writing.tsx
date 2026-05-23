"use client";

import { useState } from "react";
import {
  FounderComposeSheet,
  type FounderComposeSheetDefaults,
  type FounderComposeSheetExistingItem,
} from "@/components/founder-compose/founder-compose-sheet";

/**
 * "Continue writing" strip — unfinished drafts that the founder
 * paused on (no title, no body, no schedule, or no creative).
 *
 * Pure client component. Each pill opens the same FounderComposeSheet
 * preloaded with the draft. Tap → continue writing.
 */

export interface ContinueWritingDraft {
  itemId: string;
  title: string | null;
  /** Short description of what's missing, e.g. "no body, no creative". */
  missing: string;
  /** Full payload for the compose sheet. */
  existing: FounderComposeSheetExistingItem;
}

export interface ContinueWritingStripProps {
  drafts: ContinueWritingDraft[];
  defaults: FounderComposeSheetDefaults;
}

export function ContinueWritingStrip(props: ContinueWritingStripProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (props.drafts.length === 0) return null;
  const openDraft = props.drafts.find((d) => d.itemId === openId);
  return (
    <>
      <section className="rounded-2xl border border-signal-100 bg-signal-50/40 p-4">
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="text-sm font-semibold text-ink-900">
            Continue writing
          </h2>
          <span className="text-[11px] text-ink-500">
            {props.drafts.length} draft
            {props.drafts.length === 1 ? "" : "s"} need
            {props.drafts.length === 1 ? "s" : ""} attention
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {props.drafts.map((d) => (
            <button
              key={d.itemId}
              type="button"
              onClick={() => setOpenId(d.itemId)}
              className="text-left rounded-md border border-ink-200 bg-white px-3 py-1.5 hover:bg-ink-50 transition-colors min-w-0 max-w-xs"
            >
              <div className="text-xs font-medium text-ink-900 truncate">
                {d.title?.trim() || "Untitled draft"}
              </div>
              <div className="text-[10px] text-amber-700 truncate">
                Missing: {d.missing}
              </div>
            </button>
          ))}
        </div>
      </section>

      {openDraft ? (
        <FounderComposeSheet
          open={true}
          onClose={() => setOpenId(null)}
          defaults={props.defaults}
          existingItem={openDraft.existing}
        />
      ) : null}
    </>
  );
}
