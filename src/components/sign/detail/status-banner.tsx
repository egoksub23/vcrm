"use client";

// Doc Sign, the detail screen: one box that says what is happening to the document, in plain words.

import { useLocale, useTranslations } from "next-intl";
import { AlarmClock, Ban, CircleCheck, CircleX, Hourglass, LoaderCircle, TriangleAlert } from "lucide-react";

import { cn } from "@/lib/utils";

import { formatDay, formatWhen, joinNames } from "./format";
import { bannerTone, retentionState, type Banner, type BannerTone } from "./logic";

const TONE: Record<BannerTone, string> = {
  info: "border-sky-500/30 bg-sky-500/10",
  success: "border-emerald-500/30 bg-emerald-500/10",
  danger: "border-red-500/30 bg-red-500/10",
  warning: "border-amber-500/30 bg-amber-500/10",
  muted: "border-border bg-muted/50",
};

const ICON_TONE: Record<BannerTone, string> = {
  info: "text-sky-600 dark:text-sky-300",
  success: "text-emerald-600 dark:text-emerald-300",
  danger: "text-red-600 dark:text-red-300",
  warning: "text-amber-600 dark:text-amber-300",
  muted: "text-muted-foreground",
};

export function StatusBanner({ banner }: { banner: Banner }) {
  const t = useTranslations("Sign.detail");
  const locale = useLocale();
  if (banner.kind === "draft") return null;

  let Icon = Hourglass;
  let title = "";
  let note: string | null = null;
  let retention: string | null = null;

  switch (banner.kind) {
    case "waiting": {
      const progress = { done: banner.done, total: banner.total };
      const f = banner.form ? "Form" : "";
      title =
        banner.names.length === 0
          ? t(`banner.waitingNobody${f}`, progress)
          : banner.more > 0
            ? t(`banner.waitingMore${f}`, { names: joinNames(banner.names, locale, true), count: banner.more, ...progress })
            : t(`banner.waiting${f}`, { names: joinNames(banner.names, locale, false), ...progress });
      break;
    }
    case "sealing":
      Icon = LoaderCircle;
      title = t(banner.form ? "banner.sealingForm" : "banner.sealing");
      note = t(banner.form ? "banner.sealingNoteForm" : "banner.sealingNote");
      break;
    case "completed":
      Icon = CircleCheck;
      title = banner.at ? t(banner.form ? "banner.completedOnForm" : "banner.completedOn", { date: formatWhen(banner.at, locale) }) : t(banner.form ? "banner.completedForm" : "banner.completed");
      note = t(banner.form ? "banner.completedNoteForm" : "banner.completedNote");
      // how long it is kept: a signed document cannot be deleted before its date, by anyone
      if (banner.retainUntil) {
        const state = retentionState(banner.retainUntil, new Date());
        const date = formatDay(banner.retainUntil, locale);
        retention = state === "kept" ? t("banner.retainedUntil", { date }) : t("banner.retentionEnded", { date });
      }
      break;
    case "declined":
      Icon = CircleX;
      title =
        banner.by && banner.reason
          ? t("banner.declinedByReason", { name: banner.by, reason: banner.reason })
          : banner.by
            ? t("banner.declinedBy", { name: banner.by })
            : banner.reason
              ? t("banner.declinedReason", { reason: banner.reason })
              : t("banner.declined");
      note = t(banner.form ? "banner.declinedNoteForm" : "banner.declinedNote");
      break;
    case "expired":
      Icon = AlarmClock;
      title = banner.at ? t("banner.expiredOn", { date: formatWhen(banner.at, locale) }) : t("banner.expired");
      note = t("banner.expiredNote");
      break;
    case "voided":
      Icon = Ban;
      title = banner.reason ? t("banner.cancelledReason", { reason: banner.reason }) : t("banner.cancelled");
      note = t("banner.cancelledNote");
      break;
    case "failed":
      Icon = TriangleAlert;
      title = t("banner.failed");
      note = banner.error ? t("banner.failedTechnical", { error: banner.error }) : t("banner.failedNote");
      break;
  }

  const tone = bannerTone(banner);
  return (
    <div role="status" className={cn("flex gap-3 rounded-xl border p-4", TONE[tone])}>
      <Icon className={cn("mt-0.5 size-5 shrink-0", ICON_TONE[tone], banner.kind === "sealing" && "animate-spin motion-reduce:animate-none")} aria-hidden />
      <div className="min-w-0">
        <p className="font-medium text-foreground break-words">{title}</p>
        {note && <p className="mt-0.5 text-sm text-muted-foreground break-words">{note}</p>}
        {retention && <p className="mt-1 text-sm text-muted-foreground break-words">{retention}</p>}
      </div>
    </div>
  );
}
