"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatDaysList, parseDaysList, parseExpiryDays, patchDefaults } from "@/lib/sign/client/template-defaults";
import { SIGN_LOCALES, type SignLocale, type TemplateDefaults } from "@/lib/sign/types";

import { FormRow, NativeSelect } from "./form-bits";

interface TemplateDefaultsPanelProps {
  defaults: TemplateDefaults;
  readOnly: boolean;
  onChange: (next: TemplateDefaults) => void;
}

/** What a document made from this template starts with. Anything left blank follows the workspace's setting. */
export function TemplateDefaultsPanel({ defaults, readOnly, onChange }: TemplateDefaultsPanelProps) {
  const t = useTranslations("Sign.editor");
  // what is typed in the two number-ish boxes, kept until the box is left (so "3," is not turned into "3" mid-typing)
  const [expiry, setExpiry] = useState<string | null>(null);
  const [reminders, setReminders] = useState<string | null>(null);
  return (
    <div className="grid gap-4 p-3 sm:grid-cols-2 lg:grid-cols-3">
      <FormRow label={t("defaults.expiry")} htmlFor="sign-def-expiry" hint={t("defaults.expiryHint")}>
        <Input
          id="sign-def-expiry"
          inputMode="numeric"
          value={expiry ?? (defaults.expiry_days === undefined ? "" : String(defaults.expiry_days))}
          disabled={readOnly}
          maxLength={3}
          placeholder={t("defaults.workspace")}
          onChange={(e) => {
            setExpiry(e.target.value);
            onChange(patchDefaults(defaults, { expiry_days: parseExpiryDays(e.target.value) }));
          }}
          onBlur={() => setExpiry(null)}
        />
      </FormRow>
      <FormRow label={t("defaults.reminders")} htmlFor="sign-def-reminders" hint={t("defaults.remindersHint")}>
        <Input
          id="sign-def-reminders"
          value={reminders ?? formatDaysList(defaults.reminder_days)}
          disabled={readOnly}
          placeholder={t("defaults.workspace")}
          onChange={(e) => {
            setReminders(e.target.value);
            onChange(patchDefaults(defaults, { reminder_days: parseDaysList(e.target.value) }));
          }}
          onBlur={() => setReminders(null)}
        />
      </FormRow>
      <FormRow label={t("defaults.language")} htmlFor="sign-def-locale" hint={t("defaults.languageHint")}>
        <NativeSelect id="sign-def-locale" value={defaults.locale ?? ""} disabled={readOnly} onChange={(e) => onChange(patchDefaults(defaults, { locale: (e.target.value || undefined) as SignLocale | undefined }))}>
          <option value="">{t("defaults.workspace")}</option>
          {SIGN_LOCALES.map((l) => (
            <option key={l} value={l}>
              {t(`defaults.locales.${l}`)}
            </option>
          ))}
        </NativeSelect>
      </FormRow>
      <div className="space-y-3">
        <label className="flex items-start gap-2 text-sm">
          <Checkbox className="mt-0.5" checked={!!defaults.sign_in_order} disabled={readOnly} onCheckedChange={(v) => onChange(patchDefaults(defaults, { sign_in_order: v === true ? true : undefined }))} />
          <span>
            {t("defaults.order")}
            <span className="block text-xs text-muted-foreground">{t("defaults.orderHint")}</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox className="mt-0.5" checked={!!defaults.code_required} disabled={readOnly} onCheckedChange={(v) => onChange(patchDefaults(defaults, { code_required: v === true ? true : undefined }))} />
          <span>
            {t("defaults.code")}
            <span className="block text-xs text-muted-foreground">{t("defaults.codeHint")}</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox className="mt-0.5" checked={!!defaults.allow_forwarding} disabled={readOnly} onCheckedChange={(v) => onChange(patchDefaults(defaults, { allow_forwarding: v === true ? true : undefined }))} />
          <span>
            {t("defaults.forwarding")}
            <span className="block text-xs text-muted-foreground">{t("defaults.forwardingHint")}</span>
          </span>
        </label>
      </div>
      <FormRow label={t("defaults.subject")} htmlFor="sign-def-subject" className="sm:col-span-1">
        <Input id="sign-def-subject" value={defaults.subject ?? ""} disabled={readOnly} maxLength={200} onChange={(e) => onChange(patchDefaults(defaults, { subject: e.target.value }))} />
      </FormRow>
      <FormRow label={t("defaults.message")} htmlFor="sign-def-message" className="sm:col-span-2 lg:col-span-1">
        <Textarea id="sign-def-message" rows={3} value={defaults.message ?? ""} disabled={readOnly} maxLength={2000} onChange={(e) => onChange(patchDefaults(defaults, { message: e.target.value }))} />
      </FormRow>
    </div>
  );
}
