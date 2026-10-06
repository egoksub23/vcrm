"use client";

// Forms: the data fields of the template's form, in the placement editor's side panel. Each shows how many places on the
// pages print it, and "Place" puts a box of the right type and size at the middle of the page you are looking at, already
// bound to that data field. "Show" moves to the places that already print it.

import { Crosshair, Plus } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { printCounts } from "@/lib/sign/client/form-printing";
import { pick } from "@/lib/sign/forms/text";
import type { FormDefinition } from "@/lib/sign/forms/types";
import type { PlacedField } from "@/lib/sign/pdf/types";
import type { SignLocale } from "@/lib/sign/types";

interface DataFieldsPanelProps {
  form: FormDefinition;
  placements: readonly PlacedField[];
  locale: SignLocale;
  readOnly: boolean;
  /** The pages are loaded and there is room for another field. */
  canPlace: boolean;
  onPlace: (dataKey: string) => void;
  onShow: (dataKey: string) => void;
}

export function DataFieldsPanel({ form, placements, locale, readOnly, canPlace, onPlace, onShow }: DataFieldsPanelProps) {
  const t = useTranslations("Sign.formBuilder");
  const counts = printCounts(placements);
  if (form.fields.length === 0) return <p className="p-3 text-sm text-muted-foreground">{t("editor.dataEmpty")}</p>;
  return (
    <div className="space-y-3 p-2">
      <p className="px-1 text-xs text-muted-foreground">{t("editor.dataIntro")}</p>
      {form.parts.map((part) => {
        const fields = form.fields.filter((f) => f.part === part.key);
        if (fields.length === 0) return null;
        return (
          <section key={part.key} aria-label={pick(part.title, locale) || part.key} className="space-y-1">
            <h3 className="px-1 text-xs font-semibold text-muted-foreground">{pick(part.title, locale) || part.key}</h3>
            <ul className="space-y-1">
              {fields.map((f) => {
                const n = counts.get(f.key) ?? 0;
                const label = pick(f.label, locale) || f.key;
                const printable = f.type !== "file";
                return (
                  <li key={f.key} className="flex items-center gap-1.5 rounded-md border bg-background px-2 py-1.5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{label}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {t(`types.${f.type}`)} · {!printable ? t("editor.notPrintable") : n > 0 ? t("editor.prints", { count: n }) : t("editor.printsNone")}
                      </span>
                    </span>
                    {n > 0 ? (
                      <Button type="button" variant="ghost" size="icon-xs" aria-label={t("editor.show", { name: label })} title={t("editor.show", { name: label })} onClick={() => onShow(f.key)}>
                        <Crosshair />
                      </Button>
                    ) : null}
                    {readOnly || !printable ? null : (
                      <Button type="button" variant="outline" size="xs" disabled={!canPlace} aria-label={t("editor.placeFor", { name: label })} onClick={() => onPlace(f.key)}>
                        <Plus />
                        {t("editor.place")}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
