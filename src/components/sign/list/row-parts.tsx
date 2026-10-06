"use client";

import { useFormatter, useTranslations } from "next-intl";

import type { SignListRow } from "@/hooks/use-sign-documents";
import type { SignCategory } from "@/hooks/use-sign-categories";
import { isExpiringSoon } from "@/lib/sign/client/list-filters";
import { signerProgress, waitingSummary } from "@/lib/sign/client/status";
import { cn } from "@/lib/utils";

/** The line under a title: reference, category, contact. */
export function MetaLine({ row, categories, className }: { row: SignListRow; categories: readonly SignCategory[]; className?: string }) {
  const t = useTranslations("Sign.send.list");
  const category = row.category_id ? categories.find((c) => c.id === row.category_id)?.name : null;
  const parts = [row.reference, category, row.contacts?.name].filter((x): x is string => !!x);
  if (parts.length === 0) return <p className={cn("truncate text-xs text-muted-foreground", className)}>{t("noReference")}</p>;
  return <p className={cn("truncate text-xs text-muted-foreground", className)}>{parts.join(" · ")}</p>;
}

/** Who the document is waiting on, and how many have signed. */
export function WaitingText({ row, className }: { row: SignListRow; className?: string }) {
  const t = useTranslations("Sign.send.list");
  const signers = row.sign_signers ?? [];
  const { names, more } = waitingSummary(row.status, signers);
  const { done, total } = signerProgress(signers);
  return (
    <div className={cn("min-w-0 text-sm", className)}>
      {names.length > 0 ? (
        <p className="truncate text-foreground">{more > 0 ? t("waitingMore", { names: names.join(", "), count: more }) : names.join(", ")}</p>
      ) : (
        <p className="text-muted-foreground">{t("nobodyWaiting")}</p>
      )}
      {total > 0 && row.status !== "draft" ? <p className="text-xs text-muted-foreground">{t("progress", { done, total })}</p> : null}
    </div>
  );
}

/** Sent and expiry dates for a document that is out; the last edit for a draft; the completion date when done. */
export function DatesText({ row, now, className }: { row: SignListRow; now: number; className?: string }) {
  const t = useTranslations("Sign.send.list");
  const f = useFormatter();
  const day = (iso: string) => f.dateTime(new Date(iso), { dateStyle: "medium" });
  const ago = (iso: string) => f.relativeTime(new Date(iso), now);
  const soon = isExpiringSoon(row.status, row.expires_at, now);

  return (
    <div className={cn("text-xs text-muted-foreground", className)}>
      {row.status === "draft" ? (
        <p>{t("edited", { when: ago(row.updated_at) })}</p>
      ) : (
        <>
          {row.completed_at ? <p>{t("completedOn", { date: day(row.completed_at) })}</p> : row.sent_at ? <p>{t("sentOn", { date: day(row.sent_at) })}</p> : <p>{t("edited", { when: ago(row.updated_at) })}</p>}
          {row.expires_at && !row.completed_at ? (
            <p className={cn(soon && "font-medium text-amber-700 dark:text-amber-300")}>{t("expiresOn", { date: day(row.expires_at) })}</p>
          ) : null}
        </>
      )}
    </div>
  );
}
