"use client";

// The options of a choice or multiple-choice field: a label per language (English required), a stored value made from
// the English label when the option is created (editable until the template has been used), reorder, delete.
// Several options can be pasted at once, one per line.

import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { moveItem } from "@/lib/sign/client/form-edit";
import { isOptionValue, optionValueFromLabel, OPTION_VALUE_MAX } from "@/lib/sign/client/form-keys";
import { setText, textIn } from "@/lib/sign/client/form-text";
import { MAX_OPTIONS, type FieldOption } from "@/lib/sign/forms/types";
import type { SignLocale } from "@/lib/sign/types";
import { cn } from "@/lib/utils";

interface OptionsEditorProps {
  options: FieldOption[];
  lang: SignLocale;
  disabled?: boolean;
  /** Stored values that may no longer be edited (the template has been used). */
  lockedValues: ReadonlySet<string>;
  onChange: (options: FieldOption[], coalesceKey: string) => void;
  coalesceKey: string;
}

export function OptionsEditor({ options, lang, disabled, lockedValues, onChange, coalesceKey }: OptionsEditorProps) {
  const t = useTranslations("Sign.formBuilder");
  const [draft, setDraft] = useState("");
  const values = new Set(options.map((o) => o.value));
  const full = options.length >= MAX_OPTIONS;

  const add = () => {
    const lines = draft.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0 || full) return;
    const taken = new Set(values);
    const added: FieldOption[] = [];
    for (const line of lines.slice(0, MAX_OPTIONS - options.length)) {
      const value = optionValueFromLabel(line, taken);
      taken.add(value);
      added.push({ value, label: { en: line.slice(0, 120) } });
    }
    onChange([...options, ...added], `${coalesceKey}:add`);
    setDraft("");
  };

  const patch = (i: number, next: FieldOption, key = `${coalesceKey}:${i}`) => onChange(options.map((o, j) => (j === i ? next : o)), key);

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">{t("options.title", { count: options.length })}</p>
      {options.length === 0 ? <p className="text-xs text-destructive">{t("options.none")}</p> : null}
      <ul className="space-y-1.5">
        {options.map((o, i) => {
          const duplicate = options.some((x, j) => j !== i && x.value === o.value);
          const badValue = !isOptionValue(o.value) || duplicate;
          const labelEmpty = textIn(o.label, "en").trim() === "";
          const own = textIn(o.label, lang);
          return (
            <li key={i} className="space-y-1 rounded-md border bg-background p-1.5">
              <div className="flex items-center gap-1">
                <label className="sr-only" htmlFor={`opt-label-${i}`}>
                  {t("options.label", { n: i + 1, language: t(`lang.long.${lang}`) })}
                </label>
                <Input
                  id={`opt-label-${i}`}
                  value={own}
                  disabled={disabled}
                  maxLength={120}
                  placeholder={lang === "en" ? t("options.labelPlaceholder") : textIn(o.label, "en")}
                  aria-invalid={(lang === "en" && labelEmpty) || undefined}
                  className="h-8"
                  onChange={(e) => patch(i, { ...o, label: setText(o.label, lang, e.target.value, true) as FieldOption["label"] })}
                />
                <Button type="button" variant="ghost" size="icon-xs" disabled={disabled || i === 0} aria-label={t("options.up", { n: i + 1 })} title={t("options.up", { n: i + 1 })} onClick={() => onChange(moveItem(options, i, i - 1) as FieldOption[], `${coalesceKey}:move`)}>
                  <ArrowUp />
                </Button>
                <Button type="button" variant="ghost" size="icon-xs" disabled={disabled || i === options.length - 1} aria-label={t("options.down", { n: i + 1 })} title={t("options.down", { n: i + 1 })} onClick={() => onChange(moveItem(options, i, i + 1) as FieldOption[], `${coalesceKey}:move`)}>
                  <ArrowDown />
                </Button>
                <Button type="button" variant="ghost" size="icon-xs" disabled={disabled} aria-label={t("options.remove", { n: i + 1 })} title={t("options.remove", { n: i + 1 })} onClick={() => onChange(options.filter((_, j) => j !== i), `${coalesceKey}:remove`)}>
                  <Trash2 />
                </Button>
              </div>
              <div className="flex items-center gap-1.5 pl-0.5">
                <label className="text-[11px] text-muted-foreground" htmlFor={`opt-value-${i}`}>
                  {t("options.value")}
                </label>
                <Input
                  id={`opt-value-${i}`}
                  value={o.value}
                  disabled={disabled || lockedValues.has(o.value)}
                  maxLength={OPTION_VALUE_MAX}
                  aria-invalid={badValue || undefined}
                  className={cn("h-7 flex-1 font-mono text-xs", badValue && "border-destructive")}
                  onChange={(e) => patch(i, { ...o, value: e.target.value.replace(/[^A-Za-z0-9_.\-]/g, "") }, `${coalesceKey}:value:${i}`)}
                />
              </div>
              {lockedValues.has(o.value) ? <p className="text-[11px] text-muted-foreground">{t("options.valueLocked")}</p> : null}
              {badValue ? <p className="text-[11px] text-destructive">{duplicate ? t("options.valueDuplicate") : t("options.valueBad")}</p> : null}
            </li>
          );
        })}
      </ul>
      {disabled ? null : (
        <div className="space-y-1">
          <div className="flex items-start gap-1.5">
            <label className="sr-only" htmlFor="opt-add">
              {t("options.addLabel")}
            </label>
            <textarea
              id="opt-add"
              rows={draft.includes("\n") ? 3 : 1}
              value={draft}
              disabled={full}
              placeholder={t("options.addPlaceholder")}
              maxLength={4000}
              className="min-h-8 flex-1 resize-y rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !draft.includes("\n")) {
                  e.preventDefault();
                  add();
                }
              }}
            />
            <Button type="button" variant="outline" size="sm" disabled={full || draft.trim() === ""} onClick={add}>
              <Plus />
              {t("options.add")}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">{full ? t("options.max", { count: MAX_OPTIONS }) : t("options.addHint")}</p>
        </div>
      )}
    </div>
  );
}
