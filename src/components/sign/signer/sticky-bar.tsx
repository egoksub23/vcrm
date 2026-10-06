"use client";

// ============================================================
// Doc Sign, signing page: the bar that stays at the bottom of the screen while the document scrolls:
// how far along the person is ("2 of 4 done"), whether their work is saved, "Next field" and "Finish".
// Finish only works when nothing required is missing.
// ============================================================

import { ArrowDown, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import type { Progress, SaveState } from "@/lib/sign/client/signer-flow";

import { SaveIndicator } from "./save-indicator";

interface StickyBarProps {
  progress: Progress;
  saveState: SaveState;
  finishing: boolean;
  /** Words for a failed Finish. */
  finishError: string | null;
  /** Something other than the person's own fields stands in the way of finishing (a form's answer too long for its place); in words. */
  blockedNote?: string | null;
  /** The words of the last button when they are not "Finish" (an envelope's "Next document"). */
  finishLabel?: string;
  onNext: () => void;
  onFinish: () => void;
}

export function StickyBar({ progress, saveState, finishing, finishError, blockedNote = null, finishLabel, onNext, onFinish }: StickyBarProps) {
  const t = useTranslations("Sign.signer");
  const { required, done, attention, canFinish } = progress;
  const percent = required === 0 ? 100 : Math.round((done / required) * 100);
  const blocked = blockedNote !== null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur" role="region" aria-label={t("fill.barLabel")}>
      {finishError ? (
        <p role="alert" className="border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-center text-sm font-medium text-red-700 dark:text-red-400">
          {finishError}
        </p>
      ) : null}
      {blockedNote ? (
        <p role="status" id="sign-blocked" className="border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-center text-sm font-medium text-foreground">
          {blockedNote}
        </p>
      ) : null}
      <div className="mx-auto w-full max-w-6xl px-3 py-2 sm:flex sm:items-center sm:gap-3">
        <div className="min-w-0 space-y-1 sm:flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <p aria-live="polite" className="text-sm font-semibold leading-tight">
              {required > 0 ? t("fill.progress", { done, total: required }) : t("fill.nothingRequired")}
            </p>
            <SaveIndicator state={saveState} className="text-right leading-tight" />
          </div>
          <div role="progressbar" aria-label={t("fill.progressLabel")} aria-valuemin={0} aria-valuemax={Math.max(required, 1)} aria-valuenow={required === 0 ? 1 : done} className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-emerald-600 transition-[width] motion-reduce:transition-none dark:bg-emerald-500" style={{ width: `${percent}%` }} />
          </div>
        </div>
        <div className="mt-2 flex gap-2 sm:mt-0 sm:shrink-0">
          {!canFinish ? (
            <Button type="button" variant="outline" className="h-11 flex-1 px-3 text-sm sm:flex-none" onClick={onNext}>
              <ArrowDown className="size-4" aria-hidden />
              {t("fill.next")}
            </Button>
          ) : null}
          <Button type="button" className="h-11 flex-1 px-4 text-base sm:flex-none" disabled={!canFinish || blocked || finishing} onClick={onFinish} aria-describedby={!canFinish ? "sign-left" : blocked ? "sign-blocked" : undefined}>
            {finishing ? <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden /> : null}
            {finishing ? t("fill.finishing") : (finishLabel ?? t("fill.finish"))}
          </Button>
        </div>
        <span id="sign-left" className="sr-only">
          {t("fill.left", { count: attention.length })}
        </span>
      </div>
    </div>
  );
}
