"use client";

// ============================================================
// Doc Sign, the header of the sending workflow: the four steps, numbered, with a tick when a step is complete, the current one highlighted, and
// a step that cannot be opened yet explained (a label under it, and the same words for a screen reader). Going back is always free; going forward
// is open while the steps before it are complete, and otherwise says why. At phone width the row becomes "Step 2 of 4: People" with a list.
// The same component for a document on its own and for a document collection.
// ============================================================

import { Check, Lock } from "lucide-react";
import { useTranslations } from "next-intl";

import { PROCESS_STEPS, type ProcessStatus, type StepId } from "@/lib/sign/client/process";
import { cn } from "@/lib/utils";

export interface StepAccess {
  open: boolean;
  blockedBy: StepId | null;
}

interface Props {
  current: StepId;
  /** Null before anything exists (the first screen): no step is complete. */
  status: ProcessStatus | null;
  access: Record<StepId, StepAccess>;
  onGo: (step: StepId) => void;
  /** A form without a signature: the third step is the form, not blocks on a page. */
  formOnly?: boolean;
}

export function ProcessStepper({ current, status, access, onGo, formOnly }: Props) {
  const t = useTranslations("Sign.process.stepper");
  const name = (id: StepId) => t(id === "blocks" && formOnly ? "blocksForm" : id);
  const index = PROCESS_STEPS.indexOf(current);
  const complete = (id: StepId) => !!status?.[id].complete;
  const caption = (id: StepId): string => {
    const a = access[id];
    if (id === current) return t("current");
    if (!a.open && a.blockedBy) return t("blocked", { step: name(a.blockedBy) });
    return complete(id) ? t("done") : "";
  };

  return (
    <nav aria-label={t("label")} className="rounded-xl border border-border bg-card px-3 py-2.5 sm:px-4">
      {/* phone: one line and a list */}
      <div className="flex items-center justify-between gap-3 sm:hidden">
        <p className="min-w-0 truncate text-sm font-medium text-foreground" aria-live="polite">
          {t("compact", { n: index + 1, total: PROCESS_STEPS.length, name: name(current) })}
        </p>
        <label className="sr-only" htmlFor="process-step-select">
          {t("goTo")}
        </label>
        <select
          id="process-step-select"
          value={current}
          onChange={(e) => onGo(e.target.value as StepId)}
          className="h-8 max-w-[11rem] rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {PROCESS_STEPS.map((id, i) => (
            <option key={id} value={id} disabled={!access[id].open && id !== current}>
              {`${i + 1}. ${name(id)}${complete(id) ? ` (${t("done")})` : ""}`}
            </option>
          ))}
        </select>
      </div>

      <ol className="hidden items-start gap-1 sm:flex">
        {PROCESS_STEPS.map((id, i) => {
          const isCurrent = id === current;
          const done = complete(id);
          const a = access[id];
          const locked = !a.open && !isCurrent;
          const text = caption(id);
          return (
            <li key={id} className="flex min-w-0 flex-1 items-start gap-1">
              {i > 0 ? <span className="mt-4 h-px w-3 shrink-0 bg-border lg:w-6" aria-hidden /> : null}
              <button
                type="button"
                aria-current={isCurrent ? "step" : undefined}
                aria-disabled={locked || undefined}
                title={locked && a.blockedBy ? t("blocked", { step: name(a.blockedBy) }) : undefined}
                data-step={id}
                data-state={isCurrent ? "current" : done ? "done" : locked ? "locked" : "todo"}
                onClick={() => onGo(id)}
                className={cn(
                  "flex min-w-0 flex-1 items-start gap-2 rounded-lg px-2 py-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  isCurrent ? "bg-primary/10" : locked ? "cursor-not-allowed opacity-70" : "hover:bg-muted",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                    isCurrent ? "border-primary bg-primary text-primary-foreground" : done ? "border-[light-dark(#059669,#34d399)] bg-emerald-500/15 text-[light-dark(#047857,#6ee7b7)]" : "border-border text-muted-foreground",
                  )}
                >
                  {done && !isCurrent ? <Check className="size-3.5" aria-hidden /> : locked ? <Lock className="size-3" aria-hidden /> : i + 1}
                </span>
                <span className="min-w-0">
                  <span className={cn("block truncate text-sm", isCurrent ? "font-semibold text-foreground" : "font-medium text-foreground")}>{name(id)}</span>
                  <span className="block truncate text-xs text-muted-foreground">{text}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
