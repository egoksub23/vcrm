"use client";

import { useRef, useState } from "react";
import { AlertCircle, FileSpreadsheet, Upload, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { ContactPicker, contactLabel } from "@/components/sign/send/contact-picker";
import { checkFile, sampleCsv, type PickedContact, type WizardForm } from "@/lib/sign/client/bulk";
import { keysNeedingColumns } from "@/lib/sign/bulk/plan";
import { BULK_MAX_BYTES, BULK_MAX_ROWS } from "@/lib/sign/bulk/types";
import { downloadCsv, toCsv } from "@/lib/csv";
import { cn } from "@/lib/utils";

interface Props {
  form: WizardForm;
  mergeKeys: readonly string[];
  onChange: (patch: Partial<WizardForm>) => void;
}

const MB = 1024 * 1024;

/** Step 2: who the documents go to, from a CSV file or from contacts. */
export function PeopleStep({ form, mergeKeys, onChange }: Props) {
  const t = useTranslations("Sign.bulk");
  const input = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState<"too_large" | "not_csv" | "unreadable" | null>(null);
  const needing = keysNeedingColumns(mergeKeys);

  const chooseFile = async (file: File | null) => {
    setFileError(null);
    if (!file) return;
    const problem = checkFile(file);
    if (problem) {
      setFileError(problem);
      return;
    }
    try {
      onChange({ csvText: await file.text(), fileName: file.name });
    } catch {
      setFileError("unreadable");
    }
  };

  const addContact = (c: { id: string; name: string | null; email: string | null; phone: string | null; company: string | null } | null) => {
    if (!c || form.contacts.some((x) => x.id === c.id) || form.contacts.length >= BULK_MAX_ROWS) return;
    onChange({ contacts: [...form.contacts, { id: c.id, name: contactLabel(c) || null, email: c.email } as PickedContact] });
  };

  return (
    <div className="space-y-4">
      <div role="radiogroup" aria-label={t("people.sourceLabel")} className="grid gap-2 sm:grid-cols-2">
        {(["csv", "contacts"] as const).map((s) => (
          <label
            key={s}
            className={cn(
              "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
              form.source === s ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40",
            )}
          >
            <input type="radio" name="bulk-source" className="sr-only" checked={form.source === s} onChange={() => onChange({ source: s })} />
            {s === "csv" ? <FileSpreadsheet className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden /> : <Upload className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />}
            <span>
              <span className="block text-sm font-medium text-foreground">{t(`people.source.${s}`)}</span>
              <span className="block text-xs text-muted-foreground">{t(`people.source.${s}Hint`, { max: BULK_MAX_ROWS })}</span>
            </span>
          </label>
        ))}
      </div>

      {form.source === "csv" ? (
        <div className="space-y-3">
          <div className="rounded-lg border border-dashed border-border p-4">
            {form.csvText !== null && form.fileName ? (
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <FileSpreadsheet className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="truncate text-sm font-medium text-foreground">{form.fileName}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{t("people.fileSize", { size: Math.max(1, Math.round(new TextEncoder().encode(form.csvText).length / 1024)) })}</span>
                </div>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={t("people.removeFile")} onClick={() => onChange({ csvText: null, fileName: null })}>
                  <X />
                </Button>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 text-center">
                <p className="text-sm text-muted-foreground">{t("people.chooseHint", { max: BULK_MAX_ROWS, size: BULK_MAX_BYTES / MB })}</p>
                <Button type="button" variant="outline" onClick={() => input.current?.click()}>
                  <Upload aria-hidden />
                  {t("people.chooseFile")}
                </Button>
              </div>
            )}
            <input
              ref={input}
              type="file"
              accept=".csv,.txt,text/csv,text/plain"
              className="sr-only"
              aria-label={t("people.chooseFile")}
              tabIndex={-1}
              onChange={(e) => {
                void chooseFile(e.target.files?.[0] ?? null);
                e.target.value = "";
              }}
            />
          </div>
          {fileError ? (
            <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
              {t(`people.fileError.${fileError}`, { size: BULK_MAX_BYTES / MB })}
            </p>
          ) : null}
          <div className="space-y-1.5 rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">
            <p>{t("people.columnsHint")}</p>
            {mergeKeys.length > 0 ? <p>{t("people.valuesHint", { keys: mergeKeys.join(", ") })}</p> : null}
            <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => downloadCsv("bulk-send-sample.csv", toCsv(sampleCsv(mergeKeys)))}>
              {t("people.sample")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <ContactPicker contactId={null} onChange={addContact} />
          {needing.length > 0 ? (
            <p role="alert" className="flex items-start gap-2 text-sm text-amber-800 dark:text-amber-300">
              <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
              {t("people.contactsNeedFile", { keys: needing.join(", ") })}
            </p>
          ) : null}
          {form.contacts.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("people.noContacts")}</p>
          ) : (
            <div>
              <p className="mb-1.5 text-xs text-muted-foreground" aria-live="polite">
                {t("people.contactCount", { count: form.contacts.length, max: BULK_MAX_ROWS })}
              </p>
              <ul className="max-h-64 divide-y divide-border overflow-auto rounded-lg border border-border">
                {form.contacts.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-2 px-3 py-1.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm text-foreground">{c.name ?? c.email ?? t("people.unnamed")}</p>
                      <p className="truncate text-xs text-muted-foreground">{c.email ?? t("people.noEmail")}</p>
                    </div>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={t("people.removeContact", { name: c.name ?? c.email ?? "" })} onClick={() => onChange({ contacts: form.contacts.filter((x) => x.id !== c.id) })}>
                      <X />
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
