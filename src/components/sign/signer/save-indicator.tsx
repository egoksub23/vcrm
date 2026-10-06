"use client";

// Doc Sign, signing page: whether what the person entered is safe. Always in words as well as an icon.

import { AlertTriangle, Check, CloudOff, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import type { SaveState } from "@/lib/sign/client/signer-flow";
import { cn } from "@/lib/utils";

export function SaveIndicator({ state, className }: { state: SaveState; className?: string }) {
  const t = useTranslations("Sign.signer");
  // nothing has been entered yet, so there is nothing to say about saving
  if (state === "idle") return null;
  const Icon = state === "saving" ? Loader2 : state === "saved" ? Check : state === "offline" ? CloudOff : AlertTriangle;
  const tone = state === "offline" || state === "error" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground";
  return (
    <span role="status" className={cn("inline-flex items-center gap-1 text-xs", tone, className)}>
      <Icon className={cn("size-3.5 shrink-0", state === "saving" && "motion-safe:animate-spin")} aria-hidden />
      <span>{t(`save.${state}`)}</span>
    </span>
  );
}
