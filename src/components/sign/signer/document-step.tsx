"use client";

// ============================================================
// Doc Sign, signing page: the document, ready to be filled in. The pages, with this person's fields on
// them (amber to do, green done), what earlier signers entered shown read-only, a list of the fields
// beside or below, a sheet that opens for each field, and the bar at the bottom with progress, "Next
// field" and "Finish". Answers go to the server as they are entered (see use-signer).
// ============================================================

import { useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Minus, Plus } from "lucide-react";

import { signerFileUrl } from "@/lib/sign/client/api";
import { printedPreviews, reviewGate } from "@/lib/sign/client/signer-form";
import type { SignerFormView } from "@/lib/sign/forms/types";
import {
  checkboxAnswer,
  clearedAnswer,
  computeProgress,
  fieldProblem,
  fieldStatus,
  inputFromStored,
  nextAttentionKey,
  signerFields,
  systemFieldText,
  type Adopted,
  type Answers,
  type Rejections,
  type SaveState,
  type SignerLocale,
} from "@/lib/sign/client/signer-flow";
import type { PlacedField } from "@/lib/sign/pdf/types";
import type { AnswerInput } from "@/lib/sign/rules";
import type { SigningView } from "@/lib/sign/service/signing";

import { useBrowserTimeZone } from "./dates";
import { DocumentIntro } from "./document-intro";
import { DocumentPages } from "./document-pages";
import { useErrorText } from "./errors";
import { FieldLayer, type MyFieldView } from "./field-layer";
import { FieldList } from "./field-list";
import { FieldSheet } from "./field-sheet";
import { useFormErrorText } from "./form/form-errors";
import { ReviewPanel } from "./form/review-panel";
import { StickyBar } from "./sticky-bar";
import type { ActionResult, ReviewState } from "./use-signer";

const ZOOMS = [1, 1.5, 2, 3] as const;

type Content = NonNullable<SigningView["content"]>;

interface DocumentStepProps {
  token: string;
  view: SigningView;
  content: Content;
  answers: Answers;
  rejected: Rejections;
  saveState: SaveState;
  onAnswer: (field: PlacedField, input: AnswerInput) => void;
  onFinish: () => Promise<ActionResult>;
  onDecline: () => void;
  /** A form document: the answers printed on the page, the way back to them, and what blocks signing. Absent for a document that is only fields on the page. */
  formReview?: {
    form: SignerFormView;
    review: ReviewState;
    onChangeAnswer: () => void;
    onOpenAnswer: (partKey: string, fieldKey: string) => void;
    onRetry: () => void;
  };
}

const prefersReducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function DocumentStep({ token, view, content, answers, rejected, saveState, onAnswer, onFinish, onDecline, formReview }: DocumentStepProps) {
  const t = useTranslations("Sign.signer");
  const tf = useTranslations("Sign.signerForm");
  const locale = useLocale() as SignerLocale;
  const zone = useBrowserTimeZone();
  const errorText = useErrorText();
  const formErrorText = useFormErrorText();
  const [now] = useState(() => new Date());
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [lastKey, setLastKey] = useState<string | null>(null);
  const [highlightKey, setHighlightKey] = useState<string | null>(null);
  const [adopted, setAdopted] = useState<Adopted | null>(null);
  const [zoomIndex, setZoomIndex] = useState(0);
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);

  const { mine, system } = useMemo(() => signerFields(content.fields, view.signer.roleKey), [content.fields, view.signer.roleKey]);

  const views = useMemo<MyFieldView[]>(
    () => mine.map((field) => ({ field, status: fieldStatus(field, answers, rejected), input: answers[field.key], problemCode: fieldProblem(field, answers, rejected) })),
    [mine, answers, rejected],
  );
  const progress = useMemo(() => computeProgress(mine, answers, rejected), [mine, answers, rejected]);

  const systemViews = useMemo(() => system.map((field) => ({ field, text: systemFieldText(field, view.signer.name, now, locale, zone) })), [system, view.signer.name, now, locale, zone]);
  const review = formReview?.review;
  const reviewForm = formReview?.form;
  // what earlier signers entered, and what the form's answers print: both drawn read only, the same way
  const othersViews = useMemo(() => {
    const others = content.fields.filter((f) => f.role !== view.signer.roleKey && !f.data && content.othersAnswers[f.key]).map((field) => ({ field, input: inputFromStored(content.othersAnswers[field.key]) }));
    const printed = review?.status === "ready" ? printedPreviews(content.fields, review.printed, reviewForm ?? null) : [];
    return [...others, ...printed];
  }, [content.fields, content.othersAnswers, view.signer.roleKey, review, reviewForm]);
  const gate = formReview ? reviewGate(review ?? { status: "idle" }) : null;
  const blockedNote = !gate || gate.canFinish ? null : review?.status === "loading" ? tf("review.preparingShort") : review?.status === "error" ? tf("review.failedShort") : tf("review.blocked", { count: gate.fitCount });

  // the field that was just pointed at pulses for a moment
  useEffect(() => {
    if (!highlightKey) return;
    const timer = setTimeout(() => setHighlightKey(null), 1800);
    return () => clearTimeout(timer);
  }, [highlightKey]);

  const openField = openKey ? (mine.find((f) => f.key === openKey) ?? null) : null;

  /** Bring a field to the middle of the screen. `focus` also puts the keyboard focus on it (before the scroll: a focus change would stop a smooth one). */
  function scrollTo(key: string, focus: boolean) {
    const el = document.querySelector<HTMLElement>(`[data-field-key="${CSS.escape(key)}"]`);
    if (focus) el?.focus({ preventScroll: true });
    el?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "center", inline: "center" });
  }

  /** Tapping a field: a tick box toggles at once, anything else opens its sheet. */
  function activate(field: PlacedField) {
    setLastKey(field.key);
    if (field.type === "checkbox") onAnswer(field, checkboxAnswer(fieldStatus(field, answers, rejected) !== "done"));
    else setOpenKey(field.key);
  }

  /** From the list: scroll to the field and open it. */
  function jump(field: PlacedField) {
    scrollTo(field.key, field.type === "checkbox");
    setHighlightKey(field.key);
    if (field.type === "checkbox") setLastKey(field.key);
    else activate(field);
  }

  function next() {
    const key = nextAttentionKey(mine, progress.attention, lastKey);
    const field = key ? mine.find((f) => f.key === key) : null;
    if (field) jump(field);
  }

  async function finish() {
    setFinishing(true);
    setFinishError(null);
    const result = await onFinish();
    // on success the page moves on and this screen goes with it
    setFinishing(false);
    if (!result.ok && !result.handled) setFinishError(formErrorText(result.error) ?? errorText(result.error));
  }

  const zoom = ZOOMS[zoomIndex];

  return (
    <>
      <div className="mx-auto w-full max-w-6xl px-3 py-4 lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-6">
        <div className="min-w-0 space-y-4">
          <DocumentIntro document={view.document} />
          {formReview ? (
            <ReviewPanel review={formReview.review} form={formReview.form} locale={locale} onChangeAnswer={formReview.onChangeAnswer} onOpenAnswer={formReview.onOpenAnswer} onRetry={formReview.onRetry} />
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              className="inline-flex min-h-11 items-center rounded-lg px-1 text-sm text-muted-foreground underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
              onClick={onDecline}
            >
              {t("fill.decline")}
            </button>
            <div className="flex items-center gap-1" role="group" aria-label={t("fill.zoom")}>
              <button
                type="button"
                className="inline-flex size-11 items-center justify-center rounded-lg border bg-background outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-40"
                onClick={() => setZoomIndex((i) => Math.max(0, i - 1))}
                disabled={zoomIndex === 0}
                aria-label={t("fill.zoomOut")}
              >
                <Minus className="size-4" aria-hidden />
              </button>
              <span className="min-w-12 text-center text-sm tabular-nums" aria-live="polite">
                {Math.round(zoom * 100)}%
              </span>
              <button
                type="button"
                className="inline-flex size-11 items-center justify-center rounded-lg border bg-background outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-40"
                onClick={() => setZoomIndex((i) => Math.min(ZOOMS.length - 1, i + 1))}
                disabled={zoomIndex === ZOOMS.length - 1}
                aria-label={t("fill.zoomIn")}
              >
                <Plus className="size-4" aria-hidden />
              </button>
            </div>
          </div>
          <a
            href="#sign-fields"
            className="sr-only focus:not-sr-only focus:inline-block focus:rounded-lg focus:bg-primary focus:px-4 focus:py-3 focus:text-primary-foreground"
          >
            {t("fill.skipToFields")}
          </a>
          <DocumentPages
            url={signerFileUrl(token)}
            zoom={zoom}
            overlay={(index, size) => (
              <FieldLayer
                size={size}
                mine={views.filter((v) => v.field.page === index)}
                system={systemViews.filter((s) => s.field.page === index)}
                others={othersViews.filter((o) => o.field.page === index)}
                highlightKey={highlightKey}
                onActivate={activate}
              />
            )}
          />
        </div>
        <aside className="mt-6 lg:sticky lg:top-4 lg:mt-0">
          <FieldList id="sign-fields" mine={views} system={system} onJump={jump} />
        </aside>
      </div>

      <FieldSheet
        field={openField}
        value={openField ? answers[openField.key] : undefined}
        signerName={view.signer.name}
        adopted={adopted}
        onApply={(field, input, adopt) => {
          onAnswer(field, input);
          if (adopt) setAdopted(adopt);
          setOpenKey(null);
        }}
        onClear={(field) => {
          onAnswer(field, clearedAnswer());
          setOpenKey(null);
        }}
        onClose={() => setOpenKey(null)}
      />

      <StickyBar progress={progress} saveState={saveState} finishing={finishing} finishError={finishError} blockedNote={blockedNote} onNext={next} onFinish={() => void finish()} />
    </>
  );
}
