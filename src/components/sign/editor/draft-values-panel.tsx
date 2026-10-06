"use client";

import { useTranslations } from "next-intl";
import { useMemo } from "react";

import { Input } from "@/components/ui/input";
import { mergeKeysOf } from "@/lib/sign/client/layout";
import type { PlacedField } from "@/lib/sign/pdf/types";

import { FormRow } from "./form-bits";

interface DraftValuesPanelProps {
  fields: readonly PlacedField[];
  values: Record<string, string>;
  readOnly: boolean;
  onChange: (key: string, value: string) => void;
}

/** "Values to fill in": one input for every merge key the fields use (the sender writes these once; they are printed when the document is sent). */
export function DraftValuesPanel({ fields, values, readOnly, onChange }: DraftValuesPanelProps) {
  const t = useTranslations("Sign.editor");
  const keys = useMemo(() => mergeKeysOf(fields), [fields]);
  const labelOf = useMemo(() => {
    const byKey = new Map(fields.map((f) => [f.key, f]));
    return (field: string) => byKey.get(field)?.label?.trim() ?? "";
  }, [fields]);
  if (keys.length === 0) return null;
  const empty = keys.filter((k) => !values[k.key]?.trim()).length;
  return (
    <section aria-labelledby="sign-values-title" className="rounded-lg border bg-card p-3">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h3 id="sign-values-title" className="text-sm font-semibold">
          {t("values.title")}
        </h3>
        {empty > 0 ? <p className="text-xs text-amber-700 dark:text-amber-300">{t("values.missing", { count: empty })}</p> : <p className="text-xs text-muted-foreground">{t("values.complete")}</p>}
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">{t("values.intro")}</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {keys.map((k) => {
          const label = labelOf(k.firstField);
          const id = `sign-value-${k.key}`;
          return (
            <FormRow key={k.key} label={label || k.key} htmlFor={id} hint={label ? `${k.key} · ${t("values.used", { count: k.count })}` : t("values.used", { count: k.count })}>
              <Input id={id} value={values[k.key] ?? ""} disabled={readOnly} maxLength={2000} onChange={(e) => onChange(k.key, e.target.value)} />
            </FormRow>
          );
        })}
      </div>
    </section>
  );
}
