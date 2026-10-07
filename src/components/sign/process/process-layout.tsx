"use client";

// ============================================================
// Doc Sign, the frame of the sending workflow: the header (title and what the page is), the stepper, the step on the left and the summary on
// the right (above the footer on a phone), and the footer with Back and "Continue to <next step>" that stays in view. One frame for the first
// screen (nothing made yet) and for the draft, for a document on its own and for a collection.
// ============================================================

import type { ReactNode } from "react";
import { ArrowLeft, ArrowRight, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { PROCESS_STEPS, nextStep, previousStep, type StepId } from "@/lib/sign/client/process";
import { cn } from "@/lib/utils";

interface FrameProps {
  header: ReactNode;
  stepper: ReactNode;
  /** A line under the stepper (a step that cannot be opened yet says why). */
  notice?: ReactNode;
  summary: ReactNode;
  footer: ReactNode;
  children: ReactNode;
  /** The step is wide (the signature editor): the summary goes below it instead of beside it. */
  wide?: boolean;
  /** Names the step's region for a screen reader ("People"). */
  stepLabel: string;
}

export function ProcessFrame({ header, stepper, notice, summary, footer, children, wide = false, stepLabel }: FrameProps) {
  return (
    <div className="mx-auto max-w-[1400px] space-y-4" data-process>
      {header}
      {stepper}
      {notice}
      <div className={cn("grid items-start gap-5", wide ? "" : "lg:grid-cols-[minmax(0,1fr)_20rem]")}>
        <section className="min-w-0" aria-label={stepLabel} id="process-step">
          {children}
        </section>
        <div className={cn(!wide && "lg:sticky lg:top-4")}>{summary}</div>
      </div>
      {footer}
    </div>
  );
}

interface FooterProps {
  step: StepId;
  /** What names the next step ("People", "Review and send"). */
  nextName: string | null;
  onBack: () => void;
  onContinue: () => void;
  /** Why Continue cannot be used yet, in plain words (shown next to it). */
  blockedText?: string | null;
  busy?: boolean;
  /** Extra controls on the left (a save indicator). */
  start?: ReactNode;
  /** Continue is not offered (the last step has its own Send). */
  hideContinue?: boolean;
}

export function ProcessFooter({ step, nextName, onBack, onContinue, blockedText, busy, start, hideContinue }: FooterProps) {
  const t = useTranslations("Sign.process.footer");
  const first = previousStep(step) === null;
  const last = nextStep(step) === null;
  const blocked = !!blockedText;
  return (
    <div className="sticky bottom-0 z-30 -mx-1 border-t border-border bg-background/95 px-1 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80" data-process-footer data-step={step}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-center gap-3">
          <Button type="button" variant="outline" disabled={first || busy} onClick={onBack}>
            <ArrowLeft aria-hidden />
            {t("back")}
          </Button>
          {start}
        </div>
        {last || hideContinue ? null : (
          <div className="flex min-w-0 items-center gap-3">
            {blocked ? (
              <p className="min-w-0 text-xs text-muted-foreground" role="status" id="process-continue-why">
                {blockedText}
              </p>
            ) : null}
            <Button type="button" disabled={blocked || busy} aria-describedby={blocked ? "process-continue-why" : undefined} onClick={onContinue}>
              {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {nextName ? t("continueTo", { step: nextName }) : t("continue")}
              <ArrowRight aria-hidden />
            </Button>
          </div>
        )}
      </div>
      <p className="sr-only">{t("position", { n: PROCESS_STEPS.indexOf(step) + 1, total: PROCESS_STEPS.length })}</p>
    </div>
  );
}
