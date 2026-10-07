"use client";

// ============================================================
// Doc Sign: the lock that marks a PRIVATE document or document collection (migration 176) in the list and on the detail screen. Private means
// only the person who uploaded it, the workspace's admins and the Halo users named as signers can see it; everyone else with Doc Sign never
// meets it. The words are `Sign.private.badge` (short) and `Sign.private.badgeTitle` (the explanation, as a tooltip and for a screen reader).
// ============================================================

import { Lock } from "lucide-react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

export function PrivateBadge({ className }: { className?: string }) {
  const t = useTranslations("Sign.private");
  return (
    <span
      data-private-badge
      title={t("badgeTitle")}
      className={cn("inline-flex h-4 items-center gap-1 rounded border border-border bg-muted px-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase", className)}
    >
      <Lock className="size-2.5" aria-hidden />
      <span>{t("badge")}</span>
      <span className="sr-only">{t("badgeTitle")}</span>
    </span>
  );
}
