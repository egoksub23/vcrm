"use client";

// The editor for a registration form: what the page is called, whether it takes registrations, which document it
// sends and who fills which role, the tag the contact gets, which details it asks for, the daily cap, and the wording
// per language. The address is made by the server when the form is saved; while the name is typed the dialog shows
// how it will read. A form that cannot work is refused when it is switched on, with the reasons listed.

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { SignApiError, signRequest } from "@/lib/sign/client/api";
import { ASK_CHOICES, draftFrom, issueKey, newDraft, previewAddress, toPayload, type DraftField, type FormDraft, type FormOptions } from "@/lib/sign/client/registration-admin";
import type { AskLevel, RegistrationFormRow } from "@/lib/sign/registration/types";
import { SIGN_LOCALES } from "@/lib/sign/types";

import { Field, NativeSelect, useAdminErrorText } from "./shared";

export interface RegistrationFormDialogProps {
  /** The form being changed, or null to make one. */
  form: RegistrationFormRow | null;
  open: boolean;
  options: FormOptions;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export function RegistrationFormDialog(props: RegistrationFormDialogProps) {
  // the form starts again from the saved one each time the dialog opens for another
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">{props.open ? <RegistrationFormEditor key={props.form?.id ?? "new"} {...props} /> : null}</DialogContent>
    </Dialog>
  );
}

/** The form inside the dialog (exported so it can be drawn on its own in a test). */
export function RegistrationFormEditor({ form, options, onOpenChange, onSaved }: RegistrationFormDialogProps) {
  const t = useTranslations("Sign.admin.registration");
  const tLang = useTranslations("Sign.admin.languages");
  const errorText = useAdminErrorText();
  const [draft, setDraft] = useState<FormDraft>(() => {
    const d = form ? draftFrom(form) : newDraft();
    // a new form starts on the first template and its first role that a person signs
    if (!form && options.templates[0]) {
      const first = options.templates[0];
      d.templateId = first.id;
      d.applicantRoleKey = (first.roles.find((r) => r.kind === "signer") ?? first.roles[0])?.key ?? "";
    }
    return d;
  });
  const [problems, setProblems] = useState<Partial<Record<DraftField, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof FormDraft>(key: K, value: FormDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const template = options.templates.find((x) => x.id === draft.templateId);

  const chooseTemplate = (id: string) => {
    const next = options.templates.find((x) => x.id === id);
    setDraft((d) => ({ ...d, templateId: id, applicantRoleKey: (next?.roles.find((r) => r.kind === "signer") ?? next?.roles[0])?.key ?? "", others: {} }));
  };

  const submit = async () => {
    const result = toPayload(draft, options);
    setFailure(null);
    setIssues([]);
    if (!result.ok) {
      setProblems(Object.fromEntries(Object.entries(result.problems).map(([k, v]) => [k, `problems.${k}.${v}`])));
      return;
    }
    setProblems({});
    setSaving(true);
    try {
      if (form) await signRequest(`/api/sign/registration/forms/${form.id}`, { method: "PATCH", json: result.payload });
      else await signRequest("/api/sign/registration/forms", { method: "POST", json: result.payload });
      toast.success(form ? t("saved") : t("created"));
      onSaved();
    } catch (err) {
      if (err instanceof SignApiError && err.code === "form_not_ready") {
        setFailure(t("cannotSwitchOn"));
        setIssues(err.issues.map((i) => t(issueKey(i.code), { role: i.role ?? "" })));
      } else setFailure(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const problem = (f: DraftField) => (problems[f] ? t(problems[f]) : null);

  return (
    <form
      className="grid gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <DialogHeader>
        <DialogTitle>{form ? t("editTitle") : t("newTitle")}</DialogTitle>
        <DialogDescription>{t("dialogIntro")}</DialogDescription>
      </DialogHeader>

      <Field id="reg-name" label={t("name")} hint={form ? t("addressNow", { address: `${options.origin.replace(/\/+$/, "")}/r/${form.slug}` }) : t("addressPreview", { address: previewAddress(options.origin, draft.name) })} error={problem("name")}>
        <Input id="reg-name" value={draft.name} onChange={(e) => set("name", e.target.value)} maxLength={120} autoFocus aria-invalid={!!problems.name} aria-describedby="reg-name-hint" />
      </Field>

      <Toggle id="reg-active" label={t("takeRegistrations")} hint={t("activeHint")} checked={draft.active} onChange={(v) => set("active", v)} />

      <fieldset className="grid gap-4 rounded-lg border border-border p-3">
        <legend className="px-1 text-sm font-medium">{t("documentLegend")}</legend>
        <Toggle id="reg-send" label={t("sendDocument")} hint={t("sendDocumentHint")} checked={draft.sendDocument} onChange={(v) => set("sendDocument", v)} />
        {draft.sendDocument ? (
          options.templates.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("noTemplates")} <Link href="/sign/templates" className="text-primary underline-offset-4 hover:underline">
                {t("goToTemplates")}
              </Link>
            </p>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id="reg-template" label={t("template")} error={problem("template")}>
                  <NativeSelect id="reg-template" value={draft.templateId} onChange={chooseTemplate} options={options.templates.map((x) => ({ value: x.id, label: x.mode === "form" ? `${x.name} (${t("templateIsForm")})` : x.name }))} />
                </Field>
                <Field id="reg-role" label={t("applicantRole")} hint={t("applicantRoleHint")} error={problem("applicantRole")}>
                  <NativeSelect
                    id="reg-role"
                    value={draft.applicantRoleKey}
                    onChange={(v) => setDraft((d) => ({ ...d, applicantRoleKey: v }))}
                    options={(template?.roles ?? []).map((r) => ({ value: r.key, label: r.label }))}
                  />
                </Field>
              </div>
              {template && template.roles.length > 1 ? (
                <div className="space-y-3">
                  <p className="text-sm font-medium">{t("others")}</p>
                  <p className="text-xs text-muted-foreground">{t("othersHint")}</p>
                  {template.roles
                    .filter((r) => r.key !== draft.applicantRoleKey)
                    .map((r) => (
                      <div key={r.key} className="grid gap-3 sm:grid-cols-2">
                        <Field id={`reg-other-name-${r.key}`} label={t("otherName", { role: r.label })}>
                          <Input
                            id={`reg-other-name-${r.key}`}
                            value={draft.others[r.key]?.name ?? ""}
                            maxLength={160}
                            onChange={(e) => setDraft((d) => ({ ...d, others: { ...d.others, [r.key]: { name: e.target.value, email: d.others[r.key]?.email ?? "" } } }))}
                          />
                        </Field>
                        <Field id={`reg-other-email-${r.key}`} label={t("otherEmail", { role: r.label })}>
                          <Input
                            id={`reg-other-email-${r.key}`}
                            type="email"
                            value={draft.others[r.key]?.email ?? ""}
                            maxLength={254}
                            onChange={(e) => setDraft((d) => ({ ...d, others: { ...d.others, [r.key]: { name: d.others[r.key]?.name ?? "", email: e.target.value } } }))}
                          />
                        </Field>
                      </div>
                    ))}
                  {problems.others ? (
                    <p role="alert" className="text-xs text-destructive">
                      {problem("others")}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </>
          )
        ) : (
          <p className="text-sm text-muted-foreground">{t("detailsOnlyHint")}</p>
        )}
      </fieldset>

      <Field id="reg-tag" label={t("tag")} hint={t("tagHint")}>
        <NativeSelect id="reg-tag" value={draft.contactTagId} onChange={(v) => set("contactTagId", v)} options={[{ value: "", label: t("noTag") }, ...options.tags.map((x) => ({ value: x.id, label: x.name }))]} />
      </Field>

      <fieldset className="grid gap-4 rounded-lg border border-border p-3 sm:grid-cols-2">
        <legend className="px-1 text-sm font-medium">{t("askLegend")}</legend>
        <Ask id="reg-ask-name" label={t("detail.full_name")} value={draft.fullName} onChange={(v) => set("fullName", v)} />
        <Ask id="reg-ask-company" label={t("detail.company")} value={draft.company} onChange={(v) => set("company", v)} />
        <Ask id="reg-ask-phone" label={t("detail.phone")} value={draft.phone} onChange={(v) => set("phone", v)} />
        <div className="space-y-1.5">
          <p className="text-sm font-medium">{t("detail.email")}</p>
          <p className="flex h-9 items-center text-sm text-muted-foreground">{t("emailAlways")}</p>
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="reg-cap" label={t("dailyCap")} hint={t("dailyCapHint")} error={problem("dailyCap")}>
          <Input id="reg-cap" inputMode="numeric" value={draft.dailyCap} onChange={(e) => set("dailyCap", e.target.value)} aria-invalid={!!problems.dailyCap} aria-describedby="reg-cap-hint" />
        </Field>
        <Field id="reg-locale" label={t("defaultLanguage")} hint={t("defaultLanguageHint")}>
          <NativeSelect id="reg-locale" value={draft.defaultLocale} onChange={(v) => set("defaultLocale", v as FormDraft["defaultLocale"])} options={SIGN_LOCALES.map((l) => ({ value: l, label: tLang(l) }))} />
        </Field>
      </div>

      <details className="rounded-lg border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium text-foreground">{t("wordingTitle")}</summary>
        <p className="mt-2 text-xs text-muted-foreground">{t("wordingHint")}</p>
        <div className="mt-3 space-y-4">
          {SIGN_LOCALES.map((l) => (
            <div key={l} className="space-y-3 rounded-md bg-muted/40 p-3">
              <p className="text-sm font-medium">{tLang(l)}</p>
              <Field id={`reg-consent-${l}`} label={t("consentText")}>
                <Textarea id={`reg-consent-${l}`} value={draft.consentText[l]} onChange={(e) => setDraft((d) => ({ ...d, consentText: { ...d.consentText, [l]: e.target.value } }))} rows={3} maxLength={2000} placeholder={options.consentDefaults[l]} />
              </Field>
              <Field id={`reg-success-${l}`} label={t("successMessage")}>
                <Textarea id={`reg-success-${l}`} value={draft.successMessage[l]} onChange={(e) => setDraft((d) => ({ ...d, successMessage: { ...d.successMessage, [l]: e.target.value } }))} rows={2} maxLength={1000} />
              </Field>
            </div>
          ))}
        </div>
      </details>

      {failure ? (
        <div role="alert" className="space-y-1 text-sm text-destructive">
          <p>{failure}</p>
          {issues.length > 0 ? (
            <ul className="list-disc pl-5">
              {issues.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
          {t("cancel")}
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {form ? t("save") : t("create")}
        </Button>
      </DialogFooter>
    </form>
  );
}

function Toggle({ id, label, hint, checked, onChange }: { id: string; label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start gap-3">
      <Switch id={id} checked={checked} onCheckedChange={onChange} aria-label={label} className="mt-0.5" />
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium text-foreground">
          {label}
        </label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
    </div>
  );
}

function Ask({ id, label, value, onChange }: { id: string; label: string; value: AskLevel; onChange: (v: AskLevel) => void }) {
  const t = useTranslations("Sign.admin.registration");
  return (
    <Field id={id} label={label}>
      <NativeSelect id={id} value={value} onChange={(v) => onChange(v as AskLevel)} options={ASK_CHOICES.map((c) => ({ value: c, label: t(`ask.${c}`) }))} />
    </Field>
  );
}
