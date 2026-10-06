"use client";

// ============================================================
// Doc Sign, signing page, forms in parts: the controls where a person picks: one of a few options (a list
// of large rows), one of many (the phone's own menu), several (ticks), yes or no, and "I have read and
// accept" under a text that scrolls. Every row is at least 44 px tall.
// ============================================================

import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

import { inputChoices, inputText, type ControlProps } from "./control-props";
import { useFormText } from "./form-ui";

/** Up to this many options are shown as rows to tap; more are a menu. */
export const ROW_OPTIONS_MAX = 5;

const ROW =
  "flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border bg-background px-3 py-2 text-base has-[:checked]:border-primary has-[:checked]:bg-primary/5 has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50 has-[:disabled]:cursor-default";
const MARK = "size-5 shrink-0 accent-[var(--primary)]";

export function ChoiceControl({ field, id, input, invalid, describedBy, onInput, onBlur }: ControlProps) {
  const t = useTranslations("Sign.signerForm");
  const text = useFormText();
  const value = inputText(input);
  const options = field.options ?? [];

  if (options.length > ROW_OPTIONS_MAX) {
    return (
      <select
        id={id}
        value={value}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className="h-11 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-[invalid=true]:border-destructive"
        onChange={(e) => onInput({ text: e.target.value })}
        onBlur={onBlur}
      >
        <option value="">{t("field.choose")}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {text(o.label) || o.value}
          </option>
        ))}
      </select>
    );
  }
  return (
    <div className="space-y-2">
      {options.map((o) => (
        <label key={o.value} className={ROW}>
          <input type="radio" name={id} value={o.value} checked={value === o.value} onChange={() => onInput({ text: o.value })} onBlur={onBlur} className={MARK} />
          <span className="min-w-0 break-words">{text(o.label) || o.value}</span>
        </label>
      ))}
    </div>
  );
}

export function MultichoiceControl({ field, id, input, onInput, onBlur }: ControlProps) {
  const text = useFormText();
  const chosen = inputChoices(input);
  function toggle(value: string) {
    const next = chosen.includes(value) ? chosen.filter((c) => c !== value) : [...chosen, value];
    // keep the author's order, whatever order they were ticked in
    const order = (field.options ?? []).map((o) => o.value);
    onInput({ choices: next.sort((a, b) => order.indexOf(a) - order.indexOf(b)) });
  }
  return (
    <div className="space-y-2">
      {(field.options ?? []).map((o) => (
        <label key={o.value} className={ROW}>
          <input type="checkbox" name={id} value={o.value} checked={chosen.includes(o.value)} onChange={() => toggle(o.value)} onBlur={onBlur} className={MARK} />
          <span className="min-w-0 break-words">{text(o.label) || o.value}</span>
        </label>
      ))}
    </div>
  );
}

export function YesNoControl({ id, input, onInput, onBlur }: ControlProps) {
  const t = useTranslations("Sign.signerForm");
  const answered = typeof input.checked === "boolean";
  return (
    <div className="grid grid-cols-2 gap-2">
      {[true, false].map((yes) => (
        <label key={String(yes)} className={cn(ROW, "justify-center")}>
          <input type="radio" name={id} value={yes ? "yes" : "no"} checked={answered && input.checked === yes} onChange={() => onInput({ checked: yes })} onBlur={onBlur} className={MARK} />
          <span>{yes ? t("field.yes") : t("field.no")}</span>
        </label>
      ))}
    </div>
  );
}

/** A text to read, in a box that scrolls, and one box to tick. Not ticking is not an answer. */
export function AcknowledgeControl({ field, id, input, describedBy, onInput, onBlur }: ControlProps) {
  const t = useTranslations("Sign.signerForm");
  const text = useFormText();
  const body = text(field.text) || text(field.label);
  return (
    <div className="space-y-3">
      <div
        role="region"
        tabIndex={0}
        aria-label={text(field.label)}
        className="max-h-56 overflow-y-auto rounded-lg border bg-muted/40 p-3 text-sm leading-relaxed whitespace-pre-wrap break-words outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {body}
      </div>
      <label className={ROW}>
        <input id={id} type="checkbox" checked={input.checked === true} aria-describedby={describedBy} onChange={(e) => onInput({ checked: e.target.checked })} onBlur={onBlur} className={MARK} />
        <span className="min-w-0 break-words font-medium">{t("field.accept")}</span>
      </label>
    </div>
  );
}
