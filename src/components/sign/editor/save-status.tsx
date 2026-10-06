"use client";

import { CircleCheck, CloudOff, Loader2, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { errorMessageKey } from "@/lib/sign/client/layout";
import type { SaveState } from "@/lib/sign/client/save-queue";

interface SaveStatusProps {
  state: SaveState;
  /** The layout has problems the server would refuse, so it is not being sent. */
  blockedBy?: number;
  onRetry?: () => void;
}

/** "Saved", "Saving", "Unsaved changes" or "Could not save", always visible so nobody wonders. */
export function SaveStatus({ state, blockedBy = 0, onRetry }: SaveStatusProps) {
  const t = useTranslations("Sign.editor");
  let icon = <CircleCheck className="size-4 text-emerald-600" aria-hidden />;
  let text = t("save.saved");
  if (blockedBy > 0) {
    icon = <TriangleAlert className="size-4 text-amber-600" aria-hidden />;
    text = t("save.blocked", { count: blockedBy });
  } else if (state.kind === "saving") {
    icon = <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />;
    text = t("save.saving");
  } else if (state.kind === "dirty") {
    icon = <Loader2 className="size-4 text-muted-foreground" aria-hidden />;
    text = t("save.dirty");
  } else if (state.kind === "error") {
    icon = <CloudOff className="size-4 text-destructive" aria-hidden />;
    text = `${t("save.failed")} ${t(errorMessageKey(state.code))}${state.willRetry ? ` ${t("save.retrying")}` : ""}`;
  } else if (state.kind === "idle") {
    text = t("save.saved");
  }
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {icon}
      <span>{text}</span>
      {state.kind === "error" && onRetry ? (
        <Button type="button" variant="outline" size="xs" onClick={onRetry}>
          {t("save.retry")}
        </Button>
      ) : null}
    </div>
  );
}
