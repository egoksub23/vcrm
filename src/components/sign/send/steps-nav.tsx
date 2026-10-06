"use client";

import { Check } from "lucide-react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

export const DRAFT_STEPS = ["fields", "people", "options", "review"] as const;
export type DraftStepId = (typeof DRAFT_STEPS)[number];

interface Props {
  current: DraftStepId;
  done: Readonly<Record<DraftStepId, boolean>>;
  onGo: (step: DraftStepId) => void;
}

/** The four steps of preparing a draft. Any step can be opened; a tick (not only a colour) says it is complete. */
export function StepsNav({ current, done, onGo }: Props) {
  const t = useTranslations("Sign.send.steps");
  return (
    <nav aria-label={t("label")}>
      <ol className="flex items-center gap-1 overflow-x-auto">
        {DRAFT_STEPS.map((step, i) => {
          const isCurrent = step === current;
          return (
            <li key={step} className="flex items-center gap-1">
              {i > 0 ? <span className="h-px w-3 bg-border sm:w-6" aria-hidden /> : null}
              <button
                type="button"
                aria-current={isCurrent ? "step" : undefined}
                onClick={() => onGo(step)}
                className={cn(
                  "flex h-9 items-center gap-2 rounded-full px-2.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  isCurrent ? "bg-primary/10 font-medium text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <span
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold",
                    isCurrent ? "border-primary bg-primary text-primary-foreground" : done[step] ? "border-emerald-600 bg-emerald-500/15 text-emerald-700 dark:border-emerald-400 dark:text-emerald-300" : "border-border",
                  )}
                >
                  {done[step] && !isCurrent ? <Check className="size-3" aria-hidden /> : i + 1}
                </span>
                <span className={cn(!isCurrent && "hidden sm:inline")}>{t(step)}</span>
                {done[step] ? <span className="sr-only">{t("complete")}</span> : null}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
