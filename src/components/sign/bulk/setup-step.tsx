"use client";

import { useTranslations } from "next-intl";

import { CopyListEditor } from "@/components/sign/copy-list-editor";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { SignCategory } from "@/hooks/use-sign-categories";
import { emptyPerson, fixedSignersOf, personComplete, personStarted, type FixedPerson, type WizardForm } from "@/lib/sign/client/bulk";
import type { BulkRoleInfo } from "@/lib/sign/bulk/types";
import { SIGN_LOCALES, type SignChannel } from "@/lib/sign/types";

interface Props {
  form: WizardForm;
  roles: readonly BulkRoleInfo[];
  categories: readonly SignCategory[];
  /** Codes from `setupProblems`, shown once the sender has tried to move on. */
  problems: readonly string[];
  showInvalid: boolean;
  onChange: (patch: Partial<WizardForm>) => void;
}

const SELECT = "h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string | null; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

/** Step 3: which role the people fill, who fills the others, and what every document shares. */
export function SetupStep({ form, roles, categories, problems, showInvalid, onChange }: Props) {
  const t = useTranslations("Sign.bulk");
  const others = roles.filter((r) => r.key !== form.personRole);
  const bad = (code: string) => showInvalid && problems.includes(code);
  const setFixed = (key: string, patch: Partial<FixedPerson>) => onChange({ fixed: { ...form.fixed, [key]: { ...(form.fixed[key] ?? emptyPerson()), ...patch } } });
  const tri = (id: string, value: WizardForm["codeRequired"], set: (v: WizardForm["codeRequired"]) => void, labels: { default: string; yes: string; no: string }) => (
    <select id={id} className={SELECT} value={value} onChange={(e) => set(e.target.value as WizardForm["codeRequired"])}>
      <option value="default">{labels.default}</option>
      <option value="yes">{labels.yes}</option>
      <option value="no">{labels.no}</option>
    </select>
  );

  return (
    <div className="space-y-5">
      <section className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5">
        <h2 className="text-sm font-semibold text-foreground">{t("setup.peopleHeading")}</h2>
        <Field id="bulk-person-role" label={t("setup.personRole")} hint={t("setup.personRoleHint")} error={bad("personRole") ? t("setup.personRoleMissing") : null}>
          <select
            id="bulk-person-role"
            className={SELECT}
            value={form.personRole ?? ""}
            aria-invalid={bad("personRole")}
            onChange={(e) => onChange({ personRole: e.target.value === "" ? null : e.target.value })}
          >
            <option value="">{t("setup.chooseRole")}</option>
            {roles.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>
        </Field>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-foreground">{t("setup.channel")}</legend>
          <div className="flex flex-wrap gap-2">
            {(["email", "whatsapp"] as const satisfies readonly SignChannel[]).map((c) => (
              <label key={c} className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring ${form.channel === c ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40"}`}>
                <input type="radio" name="bulk-channel" className="sr-only" checked={form.channel === c} onChange={() => onChange({ channel: c })} />
                {t(`setup.channels.${c}`)}
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{form.channel === "whatsapp" ? t("setup.whatsappHint") : t("setup.emailHint")}</p>
        </fieldset>
      </section>

      {others.length > 0 ? (
        <section className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5">
          <div>
            <h2 className="text-sm font-semibold text-foreground">{t("setup.fixedHeading")}</h2>
            <p className="text-xs text-muted-foreground">{t("setup.fixedHint")}</p>
          </div>
          {others.map((r) => {
            const p = form.fixed[r.key] ?? emptyPerson();
            const invalid = showInvalid && problems.includes(`fixed:${r.key}`);
            const required = r.needsPerson || personStarted(form.fixed[r.key]);
            return (
              <div key={r.key} className="space-y-3 rounded-lg border border-border p-3">
                <p className="text-sm font-medium text-foreground">
                  {r.label}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">{r.needsPerson ? t("setup.fixedRequired") : t("setup.fixedOptional")}</span>
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field id={`fixed-name-${r.key}`} label={t("setup.fixedName")}>
                    <Input id={`fixed-name-${r.key}`} value={p.fullName} maxLength={160} aria-invalid={invalid && p.fullName.trim() === ""} onChange={(e) => setFixed(r.key, { fullName: e.target.value })} />
                  </Field>
                  <Field id={`fixed-email-${r.key}`} label={t("setup.fixedEmail")}>
                    <Input id={`fixed-email-${r.key}`} type="email" value={p.email} maxLength={254} aria-invalid={invalid && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email.trim())} onChange={(e) => setFixed(r.key, { email: e.target.value })} />
                  </Field>
                  <Field id={`fixed-channel-${r.key}`} label={t("setup.fixedChannel")}>
                    <select id={`fixed-channel-${r.key}`} className={SELECT} value={p.channel} onChange={(e) => setFixed(r.key, { channel: e.target.value as SignChannel })}>
                      <option value="email">{t("setup.channels.email")}</option>
                      <option value="whatsapp">{t("setup.channels.whatsapp")}</option>
                    </select>
                  </Field>
                  {p.channel === "whatsapp" ? (
                    <Field id={`fixed-phone-${r.key}`} label={t("setup.fixedPhone")} hint={t("setup.fixedPhoneHint")}>
                      <Input id={`fixed-phone-${r.key}`} type="tel" value={p.phone} maxLength={40} placeholder="+60123456789" onChange={(e) => setFixed(r.key, { phone: e.target.value })} />
                    </Field>
                  ) : null}
                </div>
                {invalid && required && !personComplete(form.fixed[r.key]) ? (
                  <p role="alert" className="text-xs text-destructive">
                    {t("setup.fixedIncomplete", { role: r.label })}
                  </p>
                ) : null}
              </div>
            );
          })}
        </section>
      ) : null}

      <section className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5">
        <h2 className="text-sm font-semibold text-foreground">{t("setup.optionsHeading")}</h2>
        <Field id="bulk-title" label={t("setup.title")} hint={t("setup.titleHint", { token: "{name}" })} error={bad("title") ? t("setup.titleTooLong") : null}>
          <Input id="bulk-title" value={form.title} maxLength={200} placeholder={t("setup.titlePlaceholder")} aria-invalid={bad("title")} onChange={(e) => onChange({ title: e.target.value })} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="bulk-category" label={t("setup.category")}>
            <select id="bulk-category" className={SELECT} value={form.categoryId ?? ""} onChange={(e) => onChange({ categoryId: e.target.value === "" ? null : e.target.value })}>
              <option value="">{t("setup.categoryDefault")}</option>
              {categories
                .filter((c) => !c.archived || c.id === form.categoryId)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field id="bulk-locale" label={t("setup.language")} hint={t("setup.languageHint")}>
            <select id="bulk-locale" className={SELECT} value={form.locale} onChange={(e) => onChange({ locale: e.target.value as WizardForm["locale"] })}>
              <option value="">{t("setup.useDefault")}</option>
              {SIGN_LOCALES.map((l) => (
                <option key={l} value={l}>
                  {t(`setup.lang.${l}`)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field id="bulk-message" label={t("setup.message")} hint={t("setup.messageHint")} error={bad("message") ? t("setup.messageTooLong") : null}>
          <Textarea id="bulk-message" rows={3} value={form.message} aria-invalid={bad("message")} onChange={(e) => onChange({ message: e.target.value })} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="bulk-expiry" label={t("setup.expiry")} hint={t("setup.expiryHint")} error={bad("expiryDays") ? t("setup.expiryBad") : null}>
            <Input id="bulk-expiry" inputMode="numeric" value={form.expiryDays} placeholder={t("setup.useDefault")} aria-invalid={bad("expiryDays")} className="max-w-[10rem]" onChange={(e) => onChange({ expiryDays: e.target.value })} />
          </Field>
          <Field id="bulk-reminders" label={t("setup.reminders")} hint={t("setup.remindersHint")} error={bad("reminders") ? t("setup.remindersBad") : null}>
            <Input id="bulk-reminders" inputMode="numeric" value={form.reminderText ?? ""} placeholder={t("setup.useDefault")} aria-invalid={bad("reminders")} className="max-w-[10rem]" onChange={(e) => onChange({ reminderText: e.target.value.trim() === "" ? null : e.target.value })} />
          </Field>
          <Field id="bulk-code" label={t("setup.code")} hint={t("setup.codeHint")}>
            {tri("bulk-code", form.codeRequired, (v) => onChange({ codeRequired: v }), { default: t("setup.useDefault"), yes: t("setup.yes"), no: t("setup.no") })}
          </Field>
          <Field id="bulk-order" label={t("setup.order")} hint={t("setup.orderHint")}>
            {tri("bulk-order", form.signInOrder, (v) => onChange({ signInOrder: v }), { default: t("setup.useDefault"), yes: t("setup.yes"), no: t("setup.no") })}
          </Field>
        </div>
      </section>

      <section className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5" data-bulk-copies>
        <CopyListEditor
          idPrefix="bulk-copy"
          rows={form.copyTo}
          onChange={(copyTo) => onChange({ copyTo })}
          showInvalid={bad("copyTo")}
          signerEmails={fixedSignersOf(form, roles).map((f) => f.email)}
          help={t("copies.help")}
        />
      </section>
    </div>
  );
}
