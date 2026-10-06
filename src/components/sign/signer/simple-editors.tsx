"use client";

// ============================================================
// Doc Sign, signing page: the sheets for the plain fields: text, number, date, a choice from a list, and
// a picture. Each checks what was typed with the server's own rules (evaluateAnswer) as it goes, so a
// mistake is named before it is sent.
// ============================================================

import { useId, useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatDate } from "@/lib/sign/pdf/format";
import type { PlacedField } from "@/lib/sign/pdf/types";
import type { AnswerInput } from "@/lib/sign/rules";
import { evaluateAnswer, imageAnswer, textAnswer, type SignerLocale } from "@/lib/sign/client/signer-flow";

import { AnswerPreview } from "./answer-preview";
import { fileToImageDataUrl } from "./image-utils";
import { FieldError, SheetActions, SheetLabel, useProblemText } from "./sheet-parts";

interface EditorProps {
  field: PlacedField;
  value: AnswerInput | undefined;
  onApply: (input: AnswerInput) => void;
  onClear: () => void;
  /** The label the field has for the person. */
  label: string;
}

const currentText = (value: AnswerInput | undefined): string => (typeof value?.text === "string" ? value.text : "");

/** Text and number. */
export function TextEditor({ field, value, onApply, onClear, label }: EditorProps) {
  const t = useTranslations("Sign.signer");
  const problemText = useProblemText();
  const id = useId();
  const errorId = useId();
  const [text, setText] = useState(currentText(value));
  const number = field.type === "number";
  const check = evaluateAnswer(field, textAnswer(text));
  const invalid = check.status === "invalid";
  const empty = text.trim() === "";
  const common = {
    id,
    value: text,
    "aria-invalid": invalid,
    "aria-describedby": invalid ? errorId : undefined,
    autoComplete: "off",
    "data-sheet-autofocus": true,
  } as const;

  function apply() {
    if (empty) onClear();
    else if (!invalid) onApply(textAnswer(text));
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!field.multiline) apply();
      }}
    >
      <SheetLabel htmlFor={id}>{label}</SheetLabel>
      {field.multiline && !number ? (
        <Textarea {...common} rows={5} maxLength={2000} className="min-h-32 text-base" onChange={(e) => setText(e.target.value)} />
      ) : (
        <Input {...common} maxLength={number ? 40 : 200} inputMode={number ? "decimal" : "text"} className="h-11 text-base" onChange={(e) => setText(e.target.value)} />
      )}
      {number ? <p className="text-xs text-muted-foreground">{t("sheet.number.hint")}</p> : null}
      {invalid ? <FieldError id={errorId}>{problemText(check.code)}</FieldError> : null}
      <SheetActions
        onApply={apply}
        applyLabel={t("sheet.apply")}
        applyDisabled={invalid || (empty && field.required)}
        onClear={value && !empty ? onClear : undefined}
        clearLabel={t("sheet.remove")}
      />
    </form>
  );
}

/** A date, picked from the browser's own date control. */
export function DateEditor({ field, value, onApply, onClear, label }: EditorProps) {
  const t = useTranslations("Sign.signer");
  const locale = useLocale() as SignerLocale;
  const problemText = useProblemText();
  const id = useId();
  const errorId = useId();
  const [text, setText] = useState(currentText(value));
  const check = evaluateAnswer(field, textAnswer(text));
  const invalid = check.status === "invalid";
  const shown = check.status === "ok" ? formatDate(new Date(`${text}T00:00:00Z`), field.dateFormat, locale, "UTC") : null;

  return (
    <div className="space-y-3">
      <SheetLabel htmlFor={id}>{label}</SheetLabel>
      <Input
        id={id}
        type="date"
        data-sheet-autofocus
        value={text}
        max="9999-12-31"
        className="h-11 text-base"
        aria-invalid={invalid}
        aria-describedby={invalid ? errorId : undefined}
        onChange={(e) => setText(e.target.value)}
      />
      {shown ? <p className="text-sm text-muted-foreground">{t("sheet.date.shownAs", { value: shown })}</p> : null}
      {invalid ? <FieldError id={errorId}>{problemText(check.code)}</FieldError> : null}
      <SheetActions
        onApply={() => (text ? onApply(textAnswer(text)) : onClear())}
        applyLabel={t("sheet.apply")}
        applyDisabled={invalid || (text === "" && field.required)}
        onClear={value && text !== "" ? onClear : undefined}
        clearLabel={t("sheet.remove")}
      />
    </div>
  );
}

/** A choice from the field's list, each option a large row. */
export function DropdownEditor({ field, value, onApply, onClear, label }: EditorProps) {
  const t = useTranslations("Sign.signer");
  const name = useId();
  const [picked, setPicked] = useState(currentText(value));
  const options = field.options ?? [];

  return (
    <fieldset className="space-y-3">
      <legend className="mb-2 text-sm font-medium">{label}</legend>
      <div className="space-y-2">
        {options.map((option) => (
          <label
            key={option}
            className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-base has-[:checked]:border-primary has-[:checked]:bg-primary/5 has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50"
          >
            <input type="radio" name={name} value={option} checked={picked === option} onChange={() => setPicked(option)} className="size-5 shrink-0 accent-[var(--primary)]" />
            <span className="min-w-0 break-words">{option}</span>
          </label>
        ))}
      </div>
      <SheetActions
        onApply={() => (picked ? onApply(textAnswer(picked)) : onClear())}
        applyLabel={t("sheet.apply")}
        applyDisabled={picked === "" && field.required}
        onClear={value && picked !== "" ? onClear : undefined}
        clearLabel={t("sheet.remove")}
      />
    </fieldset>
  );
}

/** A picture, taken or chosen, made small enough on the way. */
export function PictureEditor({ value, onApply, onClear, label }: EditorProps) {
  const t = useTranslations("Sign.signer");
  const [picture, setPicture] = useState<string | null>(typeof value?.image === "string" && value.image ? value.image : null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<"pictureTooBig" | "pictureUnreadable" | null>(null);
  const errorId = useId();

  async function choose(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setProblem(null);
    const result = await fileToImageDataUrl(file, "picture");
    setBusy(false);
    if (result.ok) setPicture(result.dataUrl);
    else setProblem(result.reason === "too_big" ? "pictureTooBig" : "pictureUnreadable");
  }

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">{label}</p>
      <label className="flex min-h-24 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-input px-3 py-4 text-center text-sm focus-within:ring-3 focus-within:ring-ring/50">
        <span className="font-medium">{picture ? t("sheet.picture.chooseAnother") : t("sheet.picture.choose")}</span>
        <span className="text-xs text-muted-foreground">{t("sheet.picture.hint")}</span>
        <input type="file" accept="image/*" className="sr-only" onChange={(e) => void choose(e.target.files?.[0])} />
      </label>
      {busy ? <p className="text-sm text-muted-foreground">{t("sheet.picture.preparing")}</p> : null}
      {picture ? (
        <div className="h-40 rounded-xl border bg-white">
          <AnswerPreview input={imageAnswer(picture)} height={160} width={300} />
        </div>
      ) : null}
      {problem ? <FieldError id={errorId}>{t(`sheet.picture.${problem}`)}</FieldError> : null}
      <SheetActions
        onApply={() => picture && onApply(imageAnswer(picture))}
        applyLabel={t("sheet.apply")}
        applyDisabled={picture === null}
        applyBusy={busy}
        onClear={value ? onClear : undefined}
        clearLabel={t("sheet.remove")}
      />
    </div>
  );
}
