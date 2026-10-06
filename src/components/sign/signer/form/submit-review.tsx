"use client";

// ============================================================
// Doc Sign, signing page, a form WITHOUT a signature (migration 169): the last look before "Submit". Every answer of the
// person's parts, part by part, in plain words, each part with a way back to change it. A sensitive answer is shown masked.
// Nothing is printed on a page here (there is no document to sign), so this is the whole review: the words come from the
// shared module that also writes the sealed record, so what is read here is what the record will hold.
// ============================================================

import { useState } from "react";
import { ArrowLeft, Loader2, Paperclip, Send } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import type { SignerLocale } from "@/lib/sign/client/signer-flow";
import { submissionSummary } from "@/lib/sign/forms/summary";
import type { SignerFormView } from "@/lib/sign/forms/types";

import { useErrorText } from "../errors";
import type { ActionResult } from "../use-signer";
import { useFormErrorText } from "./form-errors";

interface SubmitReviewProps {
  title: string;
  form: SignerFormView;
  locale: SignerLocale;
  /** What the server found wrong when it was last asked to submit, to say above the answers. */
  notice?: string | null;
  /** Back to the overview of the parts. */
  onBack: () => void;
  /** To the part an answer is in. */
  onEditPart: (partKey: string) => void;
  /** Send the answers. Resolves with `{ ok }` like every action of the page. */
  onSubmit: () => Promise<ActionResult>;
}

export function SubmitReview({ title, form, locale, notice, onBack, onEditPart, onSubmit }: SubmitReviewProps) {
  const t = useTranslations("Sign.signerForm");
  const errorText = useErrorText();
  const formErrorText = useFormErrorText();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parts = submissionSummary(form.definition, form.answers, locale).filter((p) => form.partKeys.includes(p.key));
  const anySensitive = parts.some((p) => p.rows.some((r) => r.sensitive && r.answered));

  async function submit() {
    setSubmitting(true);
    setError(null);
    const result = await onSubmit();
    // on success the page moves on and this screen goes with it
    setSubmitting(false);
    if (!result.ok && !result.handled) setError(formErrorText(result.error) ?? errorText(result.error));
  }

  const words = notice ?? error;

  return (
    <div className="space-y-5">
      <header className="space-y-2">
        <h1 className="break-words text-2xl font-semibold leading-snug">{t("submitReview.title")}</h1>
        <p className="text-sm text-muted-foreground">{title}</p>
        <p className="text-base text-muted-foreground">{t("submitReview.body")}</p>
      </header>

      {words ? (
        <p role="alert" className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm font-medium text-foreground">
          {words}
        </p>
      ) : null}

      <ol className="space-y-3" aria-label={t("submitReview.parts")}>
        {parts.map((part, i) => (
          <li key={part.key} className="rounded-xl border bg-card p-4">
            <div className="flex items-start justify-between gap-3">
              <h2 className="min-w-0 break-words text-base font-semibold leading-snug">
                <span className="text-muted-foreground">{i + 1}. </span>
                {part.title}
              </h2>
              <Button type="button" variant="outline" className="h-11 shrink-0 px-4 text-base" aria-label={t("submitReview.changePart", { part: part.title })} disabled={submitting} onClick={() => onEditPart(part.key)}>
                {t("submitReview.change")}
              </Button>
            </div>
            <dl className="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-[minmax(0,12rem)_1fr]">
              {part.rows.map((row) => (
                <div key={row.key} className="contents">
                  <dt className="text-sm text-muted-foreground">{row.label}</dt>
                  <dd className="min-w-0 whitespace-pre-line break-words text-sm text-foreground">
                    {row.files.length > 0 ? (
                      <ul className="space-y-1">
                        {row.files.map((f) => (
                          <li key={f.sha256 + f.name} className="flex items-center gap-1.5">
                            <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                            <span className="min-w-0 break-all">{f.name}</span>
                          </li>
                        ))}
                      </ul>
                    ) : row.picture ? (
                      <span>{t("submitReview.picture")}</span>
                    ) : row.answered ? (
                      row.text
                    ) : (
                      <span className="text-muted-foreground">{t("submitReview.notAnswered")}</span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ol>

      {anySensitive ? <p className="text-xs text-muted-foreground">{t("submitReview.sensitiveNote")}</p> : null}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
        <Button type="button" variant="outline" className="h-12 px-5 text-base" disabled={submitting} onClick={onBack}>
          <ArrowLeft className="size-4" aria-hidden />
          {t("submitReview.back")}
        </Button>
        <Button type="button" className="h-12 px-6 text-base" disabled={submitting} onClick={() => void submit()}>
          {submitting ? <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />}
          {submitting ? t("submitReview.submitting") : t("submitReview.submit")}
        </Button>
      </div>
      <p className="text-center text-xs text-muted-foreground">{t("submitReview.afterwards")}</p>
    </div>
  );
}
