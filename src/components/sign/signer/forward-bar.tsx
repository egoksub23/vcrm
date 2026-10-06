"use client";

// ============================================================
// Doc Sign, signing page: the line above a screen that says who asked this person to do it, when it was handed to
// them, and the way to hand their own turn on (when the sender allows it). Quiet: it is never the main thing.
// ============================================================

import { Forward } from "lucide-react";
import { useTranslations } from "next-intl";

interface ForwardBarProps {
  /** The name of the person who handed this turn, or these parts, over; null when nobody did. */
  from: string | null;
  /** This person was handed parts of the form only. */
  delegate: boolean;
  /** The whole turn can be handed to someone else. */
  canForward: boolean;
  onForward: () => void;
}

export function ForwardBar({ from, delegate, canForward, onForward }: ForwardBarProps) {
  const t = useTranslations("Sign.signer");
  if (!from && !canForward) return null;
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm">
      {from ? (
        <p role="note" className="rounded-lg border-l-4 border-primary bg-muted/50 px-3 py-2">
          {delegate ? t("forward.fromPart", { name: from }) : t("forward.fromTurn", { name: from })}
        </p>
      ) : (
        <span />
      )}
      {canForward ? (
        <button
          type="button"
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-1 text-sm text-muted-foreground underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          onClick={onForward}
        >
          <Forward className="size-4" aria-hidden />
          {t("forward.action")}
        </button>
      ) : null}
    </div>
  );
}
