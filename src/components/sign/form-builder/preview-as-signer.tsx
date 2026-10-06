"use client";

// "Preview as signer": the signer's real form, opened from the builder with test answers and no network. The form
// itself is the signer page's own `FormFlow` (so what you test is what they get); everything around it (the
// role, the language, the answers kept here, what would print on the form) is this file. Only the import and the
// props of FormFlow are tied to the signer's side; if they change, this is the one place to change.

import { RotateCcw } from "lucide-react";
import { NextIntlClientProvider, useTranslations, type AbstractIntlMessages } from "next-intl";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormFlow } from "@/components/sign/signer/form/form-flow";
import { addTestFile, applyInput, previewPercent, previewView, printedRows, removeTestFile, type TestAnswers } from "@/lib/sign/client/form-preview";
import { AUTHOR_LOCALES } from "@/lib/sign/client/form-text";
import { pick } from "@/lib/sign/forms/text";
import type { DataAnswerInput, FormDefinition } from "@/lib/sign/forms/types";
import type { PlacedField } from "@/lib/sign/pdf/types";
import type { SignLocale, SignRole } from "@/lib/sign/types";

import { FormRow, NativeSelect } from "./form-bits";
import { loadPreviewMessages } from "./preview-messages";

interface PreviewAsSignerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  form: FormDefinition;
  placements: readonly PlacedField[];
  roles: readonly SignRole[];
  /** The language the builder is showing: where the preview starts. */
  initialLang: SignLocale;
}

export function PreviewAsSigner({ open, onOpenChange, form, placements, roles, initialLang }: PreviewAsSignerProps) {
  const t = useTranslations("Sign.formBuilder");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t("preview.title")}</DialogTitle>
          <DialogDescription>{t("preview.intro")}</DialogDescription>
        </DialogHeader>
        <PreviewBody form={form} placements={placements} roles={roles} initialLang={initialLang} />
      </DialogContent>
    </Dialog>
  );
}

let fileCounter = 0;

function PreviewBody({ form, placements, roles, initialLang }: Omit<PreviewAsSignerProps, "open" | "onOpenChange">) {
  const t = useTranslations("Sign.formBuilder");
  const holders = useMemo(() => roles.filter((r) => form.parts.some((p) => p.role === r.key)), [roles, form]);
  const [roleKey, setRoleKey] = useState(holders[0]?.key ?? "");
  const [lang, setLang] = useState<SignLocale>(initialLang);
  const [answers, setAnswers] = useState<TestAnswers>({});
  const [refused, setRefused] = useState<{ field: string; code: string; detail?: string } | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [loaded, setLoaded] = useState<{ lang: SignLocale; messages: AbstractIntlMessages } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadPreviewMessages(lang).then((messages) => {
      if (!cancelled) setLoaded({ lang, messages });
    });
    return () => {
      cancelled = true;
    };
  }, [lang]);

  const role = holders.find((r) => r.key === roleKey) ?? holders[0];
  const view = useMemo(() => (role ? previewView(form, role.key, answers) : null), [form, role, answers]);
  const rows = useMemo(() => printedRows(form, placements, answers, lang), [form, placements, answers, lang]);
  const percent = role ? previewPercent(form, role.key, answers) : 0;
  const fieldLabel = (key: string) => {
    const f = form.fields.find((x) => x.key === key);
    return f ? pick(f.label, lang) || f.key : key;
  };

  const change = (key: string, input: DataAnswerInput) => {
    const r = applyInput(form, answers, key, input);
    setRefused(r.error ? { field: key, ...r.error } : null);
    setAnswers(r.answers);
    setReviewed(false);
  };
  const upload = async (key: string, file: File) => {
    const field = form.fields.find((f) => f.key === key);
    if (!field) return;
    const r = addTestFile(answers, field, { name: file.name, size: file.size, type: file.type }, `preview-${++fileCounter}`);
    setRefused(r.error ? { field: key, ...r.error } : null);
    setAnswers(r.answers);
  };
  const removeUpload = async (key: string, id: string) => {
    setAnswers((a) => removeTestFile(a, key, id));
  };

  if (holders.length === 0 || !role || !view) return <p className="text-sm text-muted-foreground">{t("preview.noParts")}</p>;

  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,390px)_minmax(0,1fr)]">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <FormRow label={t("preview.role")} htmlFor="preview-role">
            <NativeSelect
              id="preview-role"
              value={role.key}
              onChange={(e) => {
                setRoleKey(e.target.value);
                setReviewed(false);
              }}
            >
              {holders.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </NativeSelect>
          </FormRow>
          <FormRow label={t("preview.language")} htmlFor="preview-lang">
            <NativeSelect id="preview-lang" value={lang} onChange={(e) => setLang(e.target.value as SignLocale)}>
              {AUTHOR_LOCALES.map((l) => (
                <option key={l} value={l}>
                  {t(`lang.long.${l}`)}
                </option>
              ))}
            </NativeSelect>
          </FormRow>
        </div>
        <div className="mx-auto h-[62dvh] min-h-[420px] w-full max-w-[390px] overflow-y-auto rounded-[1.25rem] border-4 border-foreground/20 bg-background">
          {loaded && loaded.lang === lang ? (
            <NextIntlClientProvider locale={lang} messages={loaded.messages} timeZone="UTC">
              <div lang={lang} className="min-h-full">
                <FormFlow
                  view={view}
                  locale={lang}
                  onChange={change}
                  onUpload={upload}
                  onRemoveUpload={removeUpload}
                  onConfirmPart={() => {}}
                  onReview={() => setReviewed(true)}
                  reviewLocked={!view.ready}
                  rejected={refused ? { [refused.field]: { code: refused.code, detail: refused.detail } } : undefined}
                  preview
                />
              </div>
            </NextIntlClientProvider>
          ) : (
            <p className="p-4 text-sm text-muted-foreground">{t("preview.loading")}</p>
          )}
        </div>
      </div>

      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-medium">{t("preview.progress", { percent })}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setAnswers({});
              setRefused(null);
              setReviewed(false);
            }}
          >
            <RotateCcw />
            {t("preview.reset")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("preview.testNote")}</p>
        {refused ? (
          <p role="status" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs">
            {t("preview.refused", { field: fieldLabel(refused.field), code: refused.code })}
          </p>
        ) : null}
        {reviewed ? (
          <p role="status" className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1.5 text-xs">
            {t("preview.reviewReached")}
          </p>
        ) : null}
        <section aria-label={t("preview.printedTitle")} className="space-y-1.5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("preview.printedTitle")}</h3>
          <p className="text-xs text-muted-foreground">{t("preview.printedHint")}</p>
          {placements.some((p) => p.data) ? (
            rows.length > 0 ? (
              <ul className="divide-y rounded-lg border">
                {rows.map((r) => (
                  <li key={r.placement} className="flex items-start gap-2 px-2.5 py-1.5">
                    <span className="w-14 shrink-0 text-xs text-muted-foreground">{t("preview.page", { page: r.page })}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-muted-foreground">{fieldLabel(r.field)}</span>
                      <span className="block whitespace-pre-wrap break-words">{r.checked ? t("preview.ticked") : r.text || t("preview.picture")}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-lg border border-dashed px-2.5 py-2 text-xs text-muted-foreground">{t("preview.printedEmpty")}</p>
            )
          ) : (
            <p className="rounded-lg border border-dashed px-2.5 py-2 text-xs text-muted-foreground">{t("preview.noPlaces")}</p>
          )}
        </section>
      </div>
    </div>
  );
}
