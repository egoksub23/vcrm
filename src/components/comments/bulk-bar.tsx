"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Check, EyeOff, Loader2, ShieldAlert, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { needsConfirm, type BulkOp } from "@/lib/comments/threads";
import { Button } from "@/components/ui/button";

type Op = Extract<BulkOp, "resolve" | "spam" | "hide">;

/**
 * Mark handled / Spam / Hide for a set of comments, with the same two-step for the two that are hard to see happen (hide, spam): the button
 * turns into "Hide 11 comments? Confirm / Cancel". Used by the author block ("all") and by the bulk bar (the ticked comments).
 */
export function BulkOpButtons({
  count,
  variant,
  busy,
  onRun,
  initialConfirm = null,
}: {
  count: number;
  variant: "group" | "bar";
  busy: boolean;
  onRun: (op: Op) => void;
  /** Start with this confirmation showing (tests). */
  initialConfirm?: Op | null;
}) {
  const t = useTranslations("Comments");
  const [confirming, setConfirming] = useState<Op | null>(initialConfirm);

  if (confirming) {
    return (
      <div role="alertdialog" aria-label={t("confirm")} className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-foreground">{t(confirming === "hide" ? "confirmHide" : "confirmSpam", { count })}</span>
        <Button
          size="sm"
          className="h-7 px-2 text-xs"
          disabled={busy}
          onClick={() => {
            const op = confirming;
            setConfirming(null);
            onRun(op);
          }}
        >
          {t("confirm")}
        </Button>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setConfirming(null)}>
          {t("cancel")}
        </Button>
      </div>
    );
  }

  const go = (op: Op) => (needsConfirm(op) ? setConfirming(op) : onRun(op));
  const labels =
    variant === "group"
      ? { resolve: t("markAllHandled"), spam: t("spamAll"), hide: t("hideAll") }
      : { resolve: t("markHandled"), spam: t("markSpam"), hide: t("hide") };
  const btn = "h-7 px-2 text-xs";

  return (
    <div className="flex flex-wrap items-center gap-1">
      <Button size="sm" variant="outline" className={btn} disabled={busy || count === 0} onClick={() => go("resolve")}>
        {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Check className="mr-1 h-3 w-3" />}
        {labels.resolve}
      </Button>
      <Button size="sm" variant="ghost" className={btn} disabled={busy || count === 0} onClick={() => go("spam")}>
        <ShieldAlert className="mr-1 h-3 w-3" />
        {labels.spam}
      </Button>
      <Button size="sm" variant="ghost" className={btn} disabled={busy || count === 0} onClick={() => go("hide")}>
        <EyeOff className="mr-1 h-3 w-3" />
        {labels.hide}
      </Button>
    </div>
  );
}

/** Shown above the reply box while comments are ticked in the thread. */
export function BulkBar({
  count,
  busy,
  onRun,
  onClear,
  className,
  initialConfirm,
}: {
  count: number;
  busy: boolean;
  onRun: (op: Op) => void;
  onClear: () => void;
  className?: string;
  initialConfirm?: Op | null;
}) {
  const t = useTranslations("Comments");
  if (count === 0) return null;
  return (
    <div
      role="toolbar"
      aria-label={t("selectedCount", { count })}
      className={cn("flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border bg-muted px-3 py-2", className)}
    >
      <span className="text-xs font-medium text-foreground">{t("selectedCount", { count })}</span>
      <BulkOpButtons count={count} variant="bar" busy={busy} onRun={onRun} initialConfirm={initialConfirm} />
      <button
        type="button"
        onClick={onClear}
        className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <X className="h-3 w-3" />
        {t("clearSelection")}
      </button>
    </div>
  );
}
