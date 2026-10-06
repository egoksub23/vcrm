"use client";

// Small controls the form builder is made of: the language switch, a text box per language with English as
// the fallback, a number box that lets you type "-" or "1." on the way to a number, and a titled section.

import { useTranslations } from "next-intl";
import { useId, useState, type ReactNode } from "react";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { setText, textIn, type Coverage } from "@/lib/sign/client/form-text";
import type { L10n } from "@/lib/sign/forms/types";
import type { SignLocale } from "@/lib/sign/types";
import { cn } from "@/lib/utils";

export { FormRow, NativeSelect } from "@/components/sign/editor/form-bits";

const LANGS: readonly SignLocale[] = ["en", "ms", "zh", "ko"];

/** Which language every text box in the builder shows. English is always there; the others are optional and fall back to English. */
export function LangTabs({ lang, onLang, coverage, className }: { lang: SignLocale; onLang: (l: SignLocale) => void; coverage?: Partial<Record<SignLocale, Coverage>>; className?: string }) {
  const t = useTranslations("Sign.formBuilder");
  return (
    <div role="group" aria-label={t("lang.label")} className={cn("flex flex-wrap items-center gap-1", className)}>
      {LANGS.map((l) => {
        const c = coverage?.[l];
        const complete = !!c && c.total > 0 && c.done >= c.total;
        return (
          <button
            key={l}
            type="button"
            aria-pressed={lang === l}
            title={c ? t("lang.coverage", { done: c.done, total: c.total, language: t(`lang.long.${l}`) }) : t(`lang.long.${l}`)}
            onClick={() => onLang(l)}
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
              lang === l ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background hover:bg-muted",
            )}
          >
            {t(`lang.short.${l}`)}
            {c && l !== "en" ? (
              <span className={cn("text-[10px] font-normal tabular-nums", lang === l ? "opacity-90" : complete ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>
                {c.done}/{c.total}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

interface L10nFieldProps {
  label: string;
  value: L10n | undefined;
  lang: SignLocale;
  /** English is required (a label); otherwise the whole text is optional. */
  required?: boolean;
  multiline?: boolean;
  maxLength?: number;
  rows?: number;
  disabled?: boolean;
  hint?: string;
  /** Lets the screen move focus here (a new field or part): `[data-focus="<focusId>"]`. */
  focusId?: string;
  onChange: (next: L10n | undefined, coalesceKey: string) => void;
  coalesceKey: string;
}

/** A text box for one language of an L10n. In another language an empty box shows the English text as its placeholder and "falls back to English". */
export function L10nField({ label, value, lang, required = false, multiline = false, maxLength = 300, rows = 3, disabled, hint, focusId, onChange, coalesceKey }: L10nFieldProps) {
  const t = useTranslations("Sign.formBuilder");
  const id = useId();
  const own = textIn(value, lang);
  const english = textIn(value, "en");
  const invalid = lang === "en" && required && own.trim() === "";
  const fallback = lang !== "en" && own === "" && english !== "";
  const common = {
    id,
    value: own,
    disabled,
    maxLength,
    placeholder: lang === "en" ? undefined : english,
    "aria-invalid": invalid || undefined,
    "data-focus": focusId,
    onChange: (e: { target: { value: string } }) => onChange(setText(value, lang, e.target.value, required), `${coalesceKey}:${lang}`),
  };
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
        <span>
          {label}
          {required ? <span className="text-destructive"> *</span> : null}
        </span>
        <span className="font-normal">{t(`lang.long.${lang}`)}</span>
      </label>
      {multiline ? <Textarea {...common} rows={rows} /> : <Input {...common} />}
      {fallback ? <p className="text-[11px] leading-snug text-muted-foreground">{t("lang.fallback")}</p> : hint ? <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p> : null}
      {invalid ? <p className="text-[11px] leading-snug text-destructive">{t("lang.englishRequired")}</p> : null}
    </div>
  );
}

interface NumberFieldProps {
  id?: string;
  label: string;
  value: number | undefined;
  onChange: (next: number | undefined) => void;
  min?: number;
  max?: number;
  /** Whole numbers only. */
  integer?: boolean;
  placeholder?: string;
  disabled?: boolean;
  hint?: string;
  className?: string;
}

/** A number or nothing. What is typed is kept as text until it is a number, so "-" and "1." can be typed on the way. */
export function NumberField({ id, label, value, onChange, min, max, integer = false, placeholder, disabled, hint, className }: NumberFieldProps) {
  const auto = useId();
  const inputId = id ?? auto;
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value === undefined ? "" : String(value));
  const parsed = shown.trim() === "" ? undefined : Number(shown);
  const bad = shown.trim() !== "" && (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed)) || (min !== undefined && (parsed as number) < min) || (max !== undefined && (parsed as number) > max));
  return (
    <div className={cn("space-y-1", className)}>
      <label htmlFor={inputId} className="block text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <Input
        id={inputId}
        inputMode={integer ? "numeric" : "decimal"}
        value={shown}
        disabled={disabled}
        placeholder={placeholder}
        aria-invalid={bad || undefined}
        onChange={(e) => {
          const raw = e.target.value;
          setDraft(raw);
          if (raw.trim() === "") onChange(undefined);
          else if (Number.isFinite(Number(raw))) onChange(Number(raw));
        }}
        onBlur={() => setDraft(null)}
      />
      {hint ? <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** A titled group of controls in a properties panel. */
export function Section({ title, hint, children, className }: { title: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("space-y-2.5 border-t pt-3", className)}>
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
        {hint ? <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}
