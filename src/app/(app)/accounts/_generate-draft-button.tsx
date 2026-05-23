"use client";

import { useState } from "react";
import { GenerateDraftSheet } from "./_generate-draft-sheet";

interface GenerateDraftButtonProps {
  identity: {
    id: string;
    platform: string;
    platformLabel: string;
    displayName: string | null;
    productId: string | null;
  };
  providerAvailable: boolean;
}

export function GenerateDraftButton(props: GenerateDraftButtonProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="btn-ghost text-xs"
      >
        Generate draft
      </button>
      <GenerateDraftSheet
        open={open}
        onClose={() => setOpen(false)}
        identity={props.identity}
        providerAvailable={props.providerAvailable}
      />
    </>
  );
}
