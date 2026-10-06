"use client";

// ============================================================
// Doc Sign, signing page, forms in parts: the top of the review step. Under it is the real document with the
// answers printed where the sender put them. This says so, gives "Change an answer", and when an answer is
// too long for the place it prints, names it, says to shorten it, and opens its part: signing stays closed
// until none is left.
// ============================================================

import { AlertTriangle, ArrowLeft, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { fitTargets } from "@/lib/sign/client/signer-form";
import type { SignerLocale } from "@/lib/sign/client/signer-flow";
import type { SignerFormView } from "@/lib/sign/forms/types";

import { FormUiProvider, useFormText } from "./form-ui";

export type ReviewView = { status: "idle" } | { status: "loading" } | { status: "ready"; fitProblems: { field: string; placement: string }[] } | { status: "error" };

interface ReviewPanelProps {
  review: ReviewView;
  form: SignerFormView;
  locale: SignerLocale;
  /** Back to the overview of parts. */
  onChangeAnswer: () => void;
  /** To the part an answer is in, and the answer. */
  onOpenAnswer: (partKey: string, fieldKey: string) => void;
  onRetry: () => void;
}

export function ReviewPanel(props: ReviewPanelProps) {
  return (
    <FormUiProvider value={{ locale: props.locale }}>
      <Panel {...props} />
    </FormUiProvider>
  );
}

function Panel({ review, form, onChangeAnswer, onOpenAnswer, onRetry }: ReviewPanelProps) {
  const t = useTranslations("Sign.signerForm");
  const text = useFormText();
  const problems = review.status === "ready" ? fitTargets(form.definition, review.fitProblems) : [];

  return (
    <section aria-labelledby="review-title" className="space-y-3 rounded-xl border bg-card p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0 flex-1 space-y-1">
          <h2 id="review-title" className="text-lg font-semibold leading-snug">
            {t("review.title")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("review.body")}</p>
        </div>
        <Button type="button" variant="outline" className="h-11 w-full shrink-0 px-4 text-base sm:w-auto" onClick={onChangeAnswer}>
          <ArrowLeft className="size-4" aria-hidden />
          {t("review.change")}
        </Button>
      </div>

      {review.status === "loading" ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
          {t("review.preparing")}
        </p>
      ) : null}

      {review.status === "error" ? (
        <div role="alert" className="space-y-2 rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-foreground">
          <p className="font-medium">{t("review.failed")}</p>
          <Button type="button" variant="outline" className="h-11 bg-background px-4 text-base" onClick={onRetry}>
            {t("review.retry")}
          </Button>
        </div>
      ) : null}

      {problems.length > 0 ? (
        <div role="alert" className="space-y-3 rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-foreground">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <AlertTriangle className="size-4 shrink-0 text-destructive" aria-hidden />
            {t("review.fitTitle", { count: problems.length })}
          </h3>
          <ul className="space-y-3">
            {problems.map(({ field, part }) => (
              <li key={field.key} className="space-y-2">
                <p className="text-sm break-words">{t("review.fitItem", { label: text(field.label) })}</p>
                <Button type="button" variant="outline" className="h-11 bg-background px-4 text-base" aria-label={t("review.fixAnswerLabel", { label: text(field.label) })} onClick={() => onOpenAnswer(part, field.key)}>
                  {t("review.fixAnswer")}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
