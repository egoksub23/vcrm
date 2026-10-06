"use client";

import { AlertCircle, Check, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import type { SaveState } from "@/hooks/use-sign-autosave";
import { Button } from "@/components/ui/button";

/** "Saved", "Saving..." or "Could not save" with a way to try again. Announced politely to screen readers. */
export function SaveIndicator({ state, onRetry }: { state: SaveState; onRetry?: () => void }) {
  const t = useTranslations("Sign.send.save");
  return (
    <div className="flex min-h-6 items-center gap-1.5 text-xs text-muted-foreground" role="status" aria-live="polite">
      {state === "saving" || state === "pending" ? (
        <>
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          {t("saving")}
        </>
      ) : state === "saved" ? (
        <>
          <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden />
          {t("saved")}
        </>
      ) : state === "error" ? (
        <>
          <AlertCircle className="size-3.5 text-destructive" aria-hidden />
          <span className="text-destructive">{t("failed")}</span>
          {onRetry ? (
            <Button type="button" variant="ghost" size="xs" onClick={onRetry}>
              {t("retry")}
            </Button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
