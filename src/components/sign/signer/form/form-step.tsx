"use client";

// ============================================================
// Doc Sign, signing page, forms in parts: the form as the live page shows it. FormFlow itself makes no
// request; this is where its calls go (the page's state in use-signer), where the words for what went
// wrong are chosen, and where a person who only fills in sends their answers ("Submit"). "I do not want to
// sign" stays reachable below the form, as it is on every screen of the page.
// ============================================================

import { useState } from "react";
import { useTranslations } from "next-intl";

import type { SaveState, SignerLocale } from "@/lib/sign/client/signer-flow";
import type { FormRejections } from "@/lib/sign/client/signer-form";
import type { DataAnswerInput, SignerFormView } from "@/lib/sign/forms/types";

import { useErrorText } from "../errors";
import type { ActionResult } from "../use-signer";
import { useFormErrorText } from "./form-errors";
import { FormFlow } from "./form-flow";

interface FormStepProps {
  title: string;
  form: SignerFormView;
  locale: SignerLocale;
  saveState: SaveState;
  rejected: FormRejections;
  /** What the server found wrong at the end, to say above the form. */
  notice: "missing_required" | "invalid_answers" | "answer_does_not_fit" | null;
  start: { part?: string; field?: string; nonce: number };
  /** The person only fills in: their last step is Submit, and they never see the document to sign. */
  filler: boolean;
  /** A form without a signature (migration 169): the last step is "Review and submit", and the decline link says so. */
  formOnly?: boolean;
  onChange: (key: string, input: DataAnswerInput) => void;
  onUpload: (key: string, file: File, onProgress?: (fraction: number) => void) => Promise<void>;
  onRemoveUpload: (key: string, fileId: string) => Promise<void>;
  onConfirmPart: (partKey: string) => void;
  onFlush: () => void;
  /** Go on to the document to sign. */
  onReview: () => void;
  /** Send the answers (a filler). */
  onSubmit: () => Promise<ActionResult>;
  /** Absent for a person who was handed a part (they cannot end the document). */
  onDecline?: () => void;
  /** Forwarding (F-95): the parts this person handed over, forwarding a part, and taking one back. */
  delegations?: Record<string, { name: string; done: boolean }>;
  onForwardPart?: (partKey: string) => void;
  onTakeBack?: (partKey: string) => Promise<void>;
}

export function FormStep({ title, form, locale, saveState, rejected, notice, start, filler, formOnly, onChange, onUpload, onRemoveUpload, onConfirmPart, onFlush, onReview, onSubmit, onDecline, delegations, onForwardPart, onTakeBack }: FormStepProps) {
  const t = useTranslations("Sign.signerForm");
  const ts = useTranslations("Sign.signer");
  const errorText = useErrorText();
  const formErrorText = useFormErrorText();
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setSubmitError(null);
    const result = await onSubmit();
    // on success the page moves on and this screen goes with it
    setSubmitting(false);
    if (!result.ok && !result.handled) setSubmitError(formErrorText(result.error) ?? errorText(result.error));
  }

  const words = notice ? t(`notice.${notice}`) : submitError;

  return (
    <div className="space-y-6">
      <FormFlow
        // a part named by the page (an answer to fix) is opened by making a new form of it
        key={start.nonce}
        view={form}
        locale={locale}
        title={title}
        saveState={saveState}
        busy={submitting}
        rejected={rejected}
        notice={words}
        start={start.part ? { part: start.part, field: start.field } : undefined}
        finalAction={formOnly ? "reviewSubmit" : filler ? "submit" : "review"}
        reviewLocked={!form.ready}
        onChange={(key, input) => {
          setSubmitError(null);
          onChange(key, input);
        }}
        onUpload={onUpload}
        onRemoveUpload={onRemoveUpload}
        onConfirmPart={onConfirmPart}
        onFlush={onFlush}
        onReview={filler && !formOnly ? () => void submit() : onReview}
        delegations={delegations}
        onForwardPart={onForwardPart}
        onTakeBack={onTakeBack}
      />
      {onDecline ? (
        <div className="text-center">
          <button
            type="button"
            className="inline-flex min-h-11 items-center rounded-lg px-2 text-sm text-muted-foreground underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            onClick={onDecline}
          >
            {formOnly ? ts("fill.declineForm") : ts("fill.decline")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
