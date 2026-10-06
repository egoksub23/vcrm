"use client";

// Doc Sign, the detail screen: one box that says what is happening to the document, in plain words.

import { useLocale, useTranslations } from "next-intl";
import { AlarmClock, Ban, CircleCheck, CircleX, Hourglass, LoaderCircle, TriangleAlert } from "lucide-react";

import { cn } from "@/lib/utils";

import { formatWhen, joinNames } from "./format";
import { bannerTone, type Banner, type BannerTone } from "./logic";

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

  switch (banner.kind) {
    case "waiting": {
      const progress = { done: banner.done, total: banner.total };
      title =
        banner.names.length === 0
          ? t("banner.waitingNobody", progress)
          : banner.more > 0
            ? t("banner.waitingMore", { names: joinNames(banner.names, locale, true), count: banner.more, ...progress })
            : t("banner.waiting", { names: joinNames(banner.names, locale, false), ...progress });
      break;
    }
    case "sealing":
      Icon = LoaderCircle;
      title = t("banner.sealing");
      note = t("banner.sealingNote");
      break;
    case "completed":
      Icon = CircleCheck;
      title = banner.at ? t("banner.completedOn", { date: formatWhen(banner.at, locale) }) : t("banner.completed");
      note = t("banner.completedNote");
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
      note = t("banner.declinedNote");
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
      </div>
    </div>
  );
}
