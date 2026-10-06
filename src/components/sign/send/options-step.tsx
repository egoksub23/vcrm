"use client";

import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { SignCategory } from "@/hooks/use-sign-categories";
import { defaultExpiryDate, optionsFlags, type DraftOptions } from "@/lib/sign/client/draft-options";
import { SIGN_LOCALES } from "@/lib/sign/types";
import { ContactPicker } from "./contact-picker";

interface Props {
  options: DraftOptions;
  categories: readonly SignCategory[];
  /** What applies when the sender sets nothing: days until expiry for this category and workspace. */
  defaultExpiryDays: number;
  /** The clock, from the screen's own ticking clock (this component does not read it). */
  now: number;
  showInvalid: boolean;
  readOnly: boolean;
  onChange: (patch: Partial<DraftOptions>) => void;
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

/** Step 3: the title, category, contact, language and message of the invitation, when it expires, reminders and the code. */
export function OptionsStep({ options, categories, defaultExpiryDays, now, showInvalid, readOnly, onChange }: Props) {
  const t = useTranslations("Sign.send.options");
  const nowDate = new Date(now);
  const flags = optionsFlags(options, nowDate);
  const minDate = defaultExpiryDate(nowDate, 1);
  const defaultDate = defaultExpiryDate(nowDate, defaultExpiryDays);

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <section className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5">
        <Field id="opt-title" label={t("title")} error={flags.title && showInvalid ? t("titleRequired") : null}>
          <Input id="opt-title" value={options.title} maxLength={200} disabled={readOnly} aria-invalid={flags.title && showInvalid} onChange={(e) => onChange({ title: e.target.value })} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="opt-category" label={t("category")}>
            <select id="opt-category" className={SELECT} value={options.categoryId ?? ""} disabled={readOnly} onChange={(e) => onChange({ categoryId: e.target.value === "" ? null : e.target.value })}>
              <option value="">{t("noCategory")}</option>
              {categories
                .filter((c) => !c.archived || c.id === options.categoryId)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field id="opt-contact" label={t("contact")} hint={t("contactHint")}>
            <ContactPicker id="opt-contact" contactId={options.contactId} disabled={readOnly} onChange={(c) => onChange({ contactId: c?.id ?? null })} />
          </Field>
        </div>
      </section>

      <section className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5">
        <h2 className="text-sm font-semibold text-foreground">{t("invitationHeading")}</h2>
        <Field id="opt-locale" label={t("language")} hint={t("languageHint")}>
          <select id="opt-locale" className={SELECT} value={options.locale} disabled={readOnly} onChange={(e) => onChange({ locale: e.target.value as DraftOptions["locale"] })}>
            {SIGN_LOCALES.map((l) => (
              <option key={l} value={l}>
                {t(`lang.${l}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="opt-message" label={t("message")} hint={t("messageHint")} error={flags.message ? t("messageTooLong") : null}>
          <Textarea id="opt-message" rows={4} value={options.message} disabled={readOnly} aria-invalid={flags.message} onChange={(e) => onChange({ message: e.target.value })} />
        </Field>
      </section>

      <section className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5">
        <h2 className="text-sm font-semibold text-foreground">{t("timingHeading")}</h2>
        <Field
          id="opt-expiry"
          label={t("expiry")}
          hint={options.expiryDate === "" ? t("expiryDefault", { days: defaultExpiryDays, date: defaultDate }) : t("expiryHint")}
          error={flags.expiryPast ? t("expiryPast") : null}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Input id="opt-expiry" type="date" min={minDate} value={options.expiryDate} disabled={readOnly} aria-invalid={flags.expiryPast} className="w-44" onChange={(e) => onChange({ expiryDate: e.target.value })} />
            {options.expiryDate !== "" ? (
              <Button type="button" variant="ghost" size="sm" disabled={readOnly} onClick={() => onChange({ expiryDate: "" })}>
                {t("useDefault")}
              </Button>
            ) : null}
          </div>
        </Field>
        <Field id="opt-reminders" label={t("reminders")} hint={t("remindersHint")} error={flags.reminders ? t("remindersBad") : null}>
          <Input id="opt-reminders" value={options.reminderText} placeholder="3, 7" inputMode="numeric" disabled={readOnly} aria-invalid={flags.reminders} className="max-w-xs" onChange={(e) => onChange({ reminderText: e.target.value })} />
        </Field>
        <label className="flex cursor-pointer items-start gap-2.5">
          <Checkbox className="mt-0.5" checked={options.codeRequired} disabled={readOnly} onCheckedChange={(c) => onChange({ codeRequired: !!c })} />
          <span>
            <span className="block text-sm font-medium text-foreground">{t("codeRequired")}</span>
            <span className="block text-xs text-muted-foreground">{t("codeRequiredHint")}</span>
          </span>
        </label>
      </section>
    </div>
  );
}
