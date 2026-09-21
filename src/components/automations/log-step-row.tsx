"use client"

import { Check, X } from "lucide-react"
import { useTranslations } from "next-intl"

import type { AutomationLogStepResult } from "@/types"
import { cn } from "@/lib/utils"

/**
 * One executed step. AI steps (and Create ticket) carry an outcome, the tokens
 * they used and a short piece of the model output; the system prompt is never
 * logged, so it can never be shown here.
 */
export function StepRow({ result }: { result: AutomationLogStepResult }) {
  const tSteps = useTranslations("Automations.builder.steps")
  const t = useTranslations("Automations.logs")
  const ok = result.status === "success"
  const skipped = result.status === "skipped"
  const isAi = result.outcome !== undefined || result.tokens !== undefined
  const name = tSteps.has(result.step_type) ? tSteps(result.step_type) : result.step_type
  return (
    <li className="flex items-start gap-2 text-xs">
      <span
        className={cn(
          "mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full",
          ok
            ? "bg-primary/20 text-primary"
            : skipped
              ? "bg-amber-500/20 text-amber-400"
              : "bg-red-500/20 text-red-400",
        )}
        aria-hidden
      >
        {ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-foreground">{isAi ? name : result.step_type}</span>
          {result.outcome && (
            <span className="rounded-full border border-border px-1.5 py-px text-[10px] text-muted-foreground">
              {t.has(`outcomes.${result.outcome}`) ? t(`outcomes.${result.outcome}`) : result.outcome}
            </span>
          )}
          {typeof result.tokens === "number" && result.tokens > 0 && (
            <span className="tabular-nums text-muted-foreground">{t("tokens", { count: result.tokens })}</span>
          )}
        </div>
        {result.detail && <p className="truncate text-muted-foreground">{result.detail}</p>}
        {result.output && (
          <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap rounded bg-muted px-1.5 py-1 text-muted-foreground">
            {result.output.slice(0, 500)}
          </p>
        )}
      </div>
    </li>
  )
}
