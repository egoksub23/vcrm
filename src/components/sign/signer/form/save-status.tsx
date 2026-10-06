"use client";

// ============================================================
// Doc Sign, signing page, forms in parts: whether what the person entered is safe, in words as well as an
// icon: "Saving...", "Saved 2 minutes ago", or that there is no connection and the answers are kept.
// ============================================================

import { AlertTriangle, Check, CloudOff, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import type { SaveState } from "@/lib/sign/client/signer-flow";
import { savedAgo } from "@/lib/sign/client/signer-form";
import { cn } from "@/lib/utils";

import { useFormLocale, useNow } from "./form-ui";

interface SaveStatusProps {
  saveState?: SaveState;
  /** Something is being saved right now (a form that has no save state of its own, or an upload). */
  busy?: boolean;
  /** When the newest answer was saved on the server, if ever. */
  lastSavedAt: string | null;
  className?: string;
}

export function SaveStatus({ saveState = "idle", busy, lastSavedAt, className }: SaveStatusProps) {
  const t = useTranslations("Sign.signerForm");
  const locale = useFormLocale();
  const now = useNow();

  let state: "saving" | "saved" | "offline" | "error" | "idle" = saveState === "saving" || busy ? "saving" : saveState;
  const ago = now > 0 ? savedAgo(lastSavedAt, now) : null;
  // a save that has come back "idle" or "saved" is worded by the time, when there is one
  let words: string | null = null;
  if (state === "saving") words = t("save.saving");
  else if (state === "offline") words = t("save.offline");
  else if (state === "error") words = t("save.error");
  else if (ago) {
    state = "saved";
    words = ago.kind === "now" ? t("save.savedNow") : t("save.savedAgo", { when: new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(ago.value, ago.unit) });
  } else if (state === "saved") words = t("save.saved");
  if (!words) return null;

  const Icon = state === "saving" ? Loader2 : state === "saved" ? Check : state === "offline" ? CloudOff : AlertTriangle;
  const tone = state === "offline" || state === "error" ? "text-amber-600" : "text-muted-foreground";
  return (
    <span role="status" className={cn("inline-flex items-center gap-1 text-sm", tone, className)}>
      <Icon className={cn("size-3.5 shrink-0", state === "saving" && "motion-safe:animate-spin")} aria-hidden />
      <span>{words}</span>
    </span>
  );
}
