"use client";

// Secure Sign, step 3: a compact line under the step's heading: for each person who must sign, on how many of their documents they have a block
// (a tick when every one has, a cross when a document still has none for them). It follows the blocks as they are placed.

import { Check, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { ROLE_CLASS, roleColorStyle } from "@/lib/sign/client/colors";
import type { PersonCoverage } from "@/lib/sign/client/blocks-nav";
import { cn } from "@/lib/utils";

export function CoverageSummary({ coverage, personName, single = false }: { coverage: readonly PersonCoverage[]; personName: (index: number) => string; single?: boolean }) {
  const t = useTranslations("Sign.process.multi");
  const tb = useTranslations("Sign.process.blocks");
  if (coverage.length === 0) return null;
  return (
    <div className="space-y-1.5 rounded-xl border border-border bg-card px-3 py-2.5" data-coverage-summary>
      <p className="text-xs font-medium text-muted-foreground">{t("coverageHeading")}</p>
      <ul className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs" aria-label={t("coverageHeading")}>
        {coverage.map((p, i) => (
          <li key={p.key} data-person={p.key} data-on={p.on} data-of={p.of} data-covered={p.complete ? "true" : "false"} style={roleColorStyle(p.color)} className="inline-flex max-w-full items-center gap-1.5">
            {p.complete ? <Check className="size-3.5 shrink-0 text-[light-dark(#059669,#34d399)]" aria-hidden /> : <X className="size-3.5 shrink-0 text-[light-dark(#92400e,#fcd34d)]" aria-hidden />}
            <span className={cn("size-2 shrink-0 rounded-full", ROLE_CLASS.dot)} aria-hidden />
            <span className="truncate font-medium text-foreground">{p.name || personName(i)}</span>
            <span className={cn("shrink-0", p.complete ? "text-muted-foreground" : "text-[light-dark(#92400e,#fcd34d)]")}>{p.of === 0 ? t("coverageNowhere") : single ? (p.blocks > 0 ? tb("blockCount", { count: p.blocks }) : tb("noBlockYet")) : t("coverageLine", { on: p.on, total: p.of })}</span>
            <span className="sr-only">{p.complete ? t("coverageDone") : t("coverageLeft")}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
