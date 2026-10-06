"use client";

// ============================================================
// Doc Sign, signing page, forms in parts: one part. Its title and description, then its fields (only the
// ones shown for the answers so far: a field that depends on another appears and goes the moment that
// answer changes), then "Save and next part" and "Back to overview". Answers are saved as they are
// entered, so these buttons are for moving, and an answer that is not acceptable keeps "Save and next
// part" from moving on until it is fixed. A required answer still empty does not: the person may come
// back to it.
// ============================================================

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, History } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { fieldRequired } from "@/lib/sign/forms/rules";
import { fieldsOfPart } from "@/lib/sign/forms/completion";
import type { AnswerMap, DataAnswerInput, FormDefinition, SignerFormView } from "@/lib/sign/forms/types";
import type { SaveState } from "@/lib/sign/client/signer-flow";
import { inputFromView, requiredLeft, showWhileTyping, type Drafts, type FormRejection, type FormRejections, type PartRow } from "@/lib/sign/client/signer-form";

import { FieldRow } from "./field-row";
import { useFormText } from "./form-ui";
import { SaveStatus } from "./save-status";

interface PartScreenProps {
  definition: FormDefinition;
  row: PartRow;
  total: number;
  /** The answers as they stand, drafts included: what the conditions are worked out from. */
  answers: AnswerMap;
  view: SignerFormView;
  drafts: Drafts;
  /** Turned down by the server, by field. */
  rejected: FormRejections;
  /** Typed here and not acceptable, by field. */
  invalid: FormRejections;
  hasNext: boolean;
  saveState?: SaveState;
  busy?: boolean;
  lastSavedAt: string | null;
  /** A field to bring into view and focus when the part opens (from the review step). */
  focusField?: string | null;
  onInput: (key: string, input: DataAnswerInput) => void;
  onBack: () => void;
  onNext: () => void;
  onUpload?: (key: string, file: File, onProgress?: (fraction: number) => void) => Promise<void>;
  onRemoveUpload?: (key: string, fileId: string) => Promise<void>;
  onConfirmPart?: (partKey: string) => void;
}

export function PartScreen(props: PartScreenProps) {
  const { definition, row, total, answers, view, drafts, rejected, invalid, hasNext, saveState, busy, lastSavedAt, focusField, onInput, onBack, onNext, onUpload, onRemoveUpload, onConfirmPart } = props;
  const t = useTranslations("Sign.signerForm");
  const text = useFormText();
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [attempted, setAttempted] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  const part = row.part;
  const fields = fieldsOfPart(definition, part.key, answers);
  const description = text(part.description);
  const unconfirmed = fields.filter((f) => view.unconfirmed.includes(f.key));
  const left = requiredLeft(row);

  // what is wrong with a field, if it is time to say so
  function problemOf(key: string): FormRejection | null {
    const server = rejected[key];
    if (server) return server;
    const typed = invalid[key];
    return typed && (attempted || touched.has(key) || showWhileTyping(typed.code)) ? typed : null;
  }
  const firstInvalid = fields.find((f) => invalid[f.key]);
  const marked = fields.some((f) => problemOf(f.key));

  function focusIn(key: string) {
    const wrapper = root.current?.querySelector<HTMLElement>(`[data-form-field="${CSS.escape(key)}"]`);
    const control = wrapper?.querySelector<HTMLElement>("input:not([type=file]), textarea, select, button");
    (control ?? wrapper)?.scrollIntoView({ block: "center" });
    control?.focus({ preventScroll: true });
  }

  // arriving from the review step with an answer to change: take the person to it
  useEffect(() => {
    if (focusField) focusIn(focusField);
    // once, when the part opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function save() {
    setAttempted(true);
    if (firstInvalid) {
      focusIn(firstInvalid.key);
      return;
    }
    onNext();
  }

  return (
    <div ref={root} className="space-y-5">
      <header className="space-y-2">
        <p className="text-sm text-muted-foreground">{t("part.position", { number: row.number, total })}</p>
        <h1 className="text-2xl font-semibold leading-snug break-words">{text(part.title)}</h1>
        {description ? <p className="text-base leading-relaxed text-muted-foreground whitespace-pre-wrap break-words">{description}</p> : null}
        <SaveStatus saveState={saveState} busy={busy} lastSavedAt={lastSavedAt} />
      </header>

      {unconfirmed.length > 0 ? (
        <section aria-labelledby="part-confirm-title" className="space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-foreground">
          <h2 id="part-confirm-title" className="flex items-center gap-2 text-sm font-semibold">
            <History className="size-4 shrink-0 text-amber-600" aria-hidden />
            {t("part.confirmTitle")}
          </h2>
          <p className="text-sm">{t("part.confirmBody")}</p>
          {onConfirmPart ? (
            <Button type="button" variant="outline" className="h-11 w-full bg-background px-4 text-base sm:w-auto" onClick={() => onConfirmPart(part.key)}>
              {t("part.confirm")}
            </Button>
          ) : null}
        </section>
      ) : null}

      {fields.length === 0 ? (
        <p className="rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">{t("part.empty")}</p>
      ) : (
        <div className="space-y-6">
          {fields.map((field) => (
            <FieldRow
              key={field.key}
              field={field}
              input={drafts[field.key] ?? inputFromView(view.answers[field.key])}
              stored={view.answers[field.key]}
              required={fieldRequired(definition, field, answers)}
              unconfirmed={view.unconfirmed.includes(field.key)}
              rejection={problemOf(field.key)}
              onInput={(input) => onInput(field.key, input)}
              onBlur={() => setTouched((cur) => (cur.has(field.key) ? cur : new Set(cur).add(field.key)))}
              onUpload={onUpload}
              onRemoveUpload={onRemoveUpload}
            />
          ))}
        </div>
      )}

      <div className="space-y-3 border-t pt-4">
        <p role="status" className="text-sm text-muted-foreground">
          {marked ? t("part.needsChange") : left > 0 ? t("part.left", { count: left }) : t("part.complete")}
        </p>
        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <Button type="button" className="h-12 w-full px-5 text-base sm:w-auto" onClick={save}>
            {hasNext ? t("part.saveNext") : t("part.saveLast")}
          </Button>
          <Button type="button" variant="outline" className="h-12 w-full px-5 text-base sm:w-auto" onClick={onBack}>
            <ArrowLeft className="size-4" aria-hidden />
            {t("part.back")}
          </Button>
        </div>
      </div>
    </div>
  );
}
