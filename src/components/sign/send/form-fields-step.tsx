"use client";

import { useState } from "react";
import { ClipboardList, Pencil } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { DraftFieldsEditor } from "@/components/sign/editor/draft-fields-editor";
import { Button } from "@/components/ui/button";
import { roleColorStyle, ROLE_CLASS } from "@/lib/sign/client/colors";
import { asLocale } from "@/lib/sign/client/progress-logic";
import { formPartLines } from "@/lib/sign/client/progress-send";
import type { FormDefinition } from "@/lib/sign/forms/types";
import type { SignRole } from "@/lib/sign/types";
import { cn } from "@/lib/utils";

interface Props {
  documentId: string;
  form: FormDefinition;
  roles: readonly SignRole[];
  readOnly: boolean;
  onChanged: () => void;
  /** A form without a signature (migration 169): nothing is printed on a page, so there is no placement editor to open. */
  formOnly?: boolean;
}

/**
 * Step 1 for a document that carries a form: the form itself (the parts, who completes each, how many fields) instead of
 * the field editor. The form belongs to the template. "Edit fields" opens the editor to change where the answers
 * print on the pages, never the form.
 */
export function FormFieldsStep({ documentId, form, roles, readOnly, onChanged, formOnly }: Props) {
  const t = useTranslations("Sign.progress.formStep");
  const locale = asLocale(useLocale());
  const [editing, setEditing] = useState(false);
  const lines = formPartLines(form, roles, locale);
  const fieldTotal = form.fields.length;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <section aria-labelledby="form-summary-title" className="space-y-3 rounded-xl border border-border bg-card p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <ClipboardList className="size-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 id="form-summary-title" className="text-base font-semibold text-foreground">
              {t("title")}
            </h2>
            <p className="text-sm text-muted-foreground">{t("summary", { parts: lines.length, fields: fieldTotal })}</p>
          </div>
        </div>

        <ol className="divide-y divide-border rounded-lg border border-border" aria-label={t("partsList")}>
          {lines.map((l) => (
            <li key={l.key} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 px-3 py-2 text-sm sm:grid-cols-[1.6fr_1fr_auto]">
              <span className="min-w-0 break-words text-foreground">
                <span className="text-muted-foreground">{l.number} </span>
                {l.title}
              </span>
              <span style={roleColorStyle(l.color)} className={cn("inline-flex h-5 w-fit items-center gap-1 justify-self-end rounded-full border px-2 text-xs font-medium sm:justify-self-start", ROLE_CLASS.chip)}>
                <span className={cn("size-1.5 rounded-full", ROLE_CLASS.dot)} aria-hidden />
                {l.roleLabel}
              </span>
              <span className="col-span-2 text-xs text-muted-foreground sm:col-span-1">{t("fieldCount", { count: l.fieldCount })}</span>
            </li>
          ))}
        </ol>

        <p className="text-xs text-muted-foreground">{t("belongsToTemplate")}</p>
      </section>

      {formOnly ? null : (
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant={editing ? "secondary" : "outline"} aria-expanded={editing} disabled={readOnly} onClick={() => setEditing((v) => !v)}>
          <Pencil aria-hidden />
          {editing ? t("hideEditor") : t("editFields")}
        </Button>
        <p className="text-xs text-muted-foreground">{t("editFieldsNote")}</p>
      </div>
      )}

      {editing && !formOnly ? <DraftFieldsEditor documentId={documentId} onChanged={onChanged} /> : null}
    </div>
  );
}
