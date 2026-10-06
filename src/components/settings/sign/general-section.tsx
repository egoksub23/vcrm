"use client";

// Settings > Doc Sign > General: the defaults a new document starts from, the sender name on invitations, the
// WhatsApp template used only when a sender chooses WhatsApp, and the retention period (read only here).
// The row is written with the browser client under row level security (sign.settings).

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCapability } from "@/hooks/use-can";
import { formatReminderDays, parseReminderDays, parseWholeNumber } from "@/lib/sign/client/admin-settings";
import { createClient } from "@/lib/supabase/client";
import { SIGN_LOCALES, type SignLocale, type SignSettingsRow } from "@/lib/sign/types";

import { Field, NativeSelect } from "./shared";

const TEMPLATE_NAME_RE = /^[a-z0-9_]{1,512}$/;
const TEMPLATE_LANG_RE = /^[a-z]{2}(_[A-Z]{2})?$/;

type Errors = Partial<Record<"expiry" | "reminders" | "sender" | "waName" | "waLang", string>>;

export function GeneralSection({ settings, onSaved }: { settings: SignSettingsRow; onSaved: (row: SignSettingsRow) => void }) {
  const t = useTranslations("Sign.admin.general");
  const tLang = useTranslations("Sign.admin.languages");
  const canEdit = useCapability("sign.settings");

  const [expiry, setExpiry] = useState(String(settings.default_expiry_days));
  const [reminders, setReminders] = useState(formatReminderDays(settings.reminder_days));
  const [language, setLanguage] = useState<SignLocale>(settings.default_language);
  const [sender, setSender] = useState(settings.sender_name ?? "");
  const [waName, setWaName] = useState(settings.whatsapp_template_name ?? "");
  const [waLang, setWaLang] = useState(settings.whatsapp_template_language || "en");
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const next: Errors = {};
    const expiryDays = parseWholeNumber(expiry, 1, 365);
    if (expiryDays === null) next.expiry = t("errors.expiry");
    const parsed = parseReminderDays(reminders);
    if ("problem" in parsed) next.reminders = t(`errors.reminders_${parsed.problem}`);
    if (sender.trim().length > 120) next.sender = t("errors.sender");
    const name = waName.trim();
    if (name && !TEMPLATE_NAME_RE.test(name)) next.waName = t("errors.waName");
    if (!TEMPLATE_LANG_RE.test(waLang.trim())) next.waLang = t("errors.waLang");
    setErrors(next);
    if (Object.keys(next).length > 0 || expiryDays === null || "problem" in parsed) return;

    setSaving(true);
    const { data, error } = await createClient()
      .from("sign_settings")
      .update({
        default_expiry_days: expiryDays,
        reminder_days: parsed.days,
        default_language: language,
        sender_name: sender.trim() || null,
        whatsapp_template_name: name || null,
        whatsapp_template_language: waLang.trim(),
      })
      .eq("id", settings.id)
      .select("*")
      .single();
    setSaving(false);
    if (error || !data) {
      toast.error(t("saveFailed"));
      return;
    }
    toast.success(t("saved"));
    onSaved(data as SignSettingsRow);
  };

  return (
    <form
      className="max-w-2xl space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <p className="text-sm text-muted-foreground">{t("intro")}</p>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="sign-expiry" label={t("expiry")} hint={t("expiryHint")} error={errors.expiry}>
          <Input id="sign-expiry" inputMode="numeric" value={expiry} onChange={(e) => setExpiry(e.target.value)} disabled={!canEdit} aria-invalid={!!errors.expiry} aria-describedby="sign-expiry-hint" />
        </Field>
        <Field id="sign-reminders" label={t("reminders")} hint={t("remindersHint")} error={errors.reminders}>
          <Input id="sign-reminders" value={reminders} onChange={(e) => setReminders(e.target.value)} placeholder="3, 7" disabled={!canEdit} aria-invalid={!!errors.reminders} aria-describedby="sign-reminders-hint" />
        </Field>
        <Field id="sign-language" label={t("language")} hint={t("languageHint")}>
          <NativeSelect id="sign-language" value={language} onChange={(v) => setLanguage(v as SignLocale)} disabled={!canEdit} options={SIGN_LOCALES.map((l) => ({ value: l, label: tLang(l) }))} />
        </Field>
        <Field id="sign-sender" label={t("sender")} hint={t("senderHint")} error={errors.sender}>
          <Input id="sign-sender" value={sender} onChange={(e) => setSender(e.target.value)} maxLength={120} disabled={!canEdit} aria-describedby="sign-sender-hint" />
        </Field>
      </div>

      <fieldset className="space-y-3 rounded-lg border border-border p-4">
        <legend className="px-1 text-sm font-semibold text-foreground">{t("whatsappTitle")}</legend>
        <p className="text-sm text-muted-foreground">{t("whatsappIntro")}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="sign-wa-name" label={t("whatsappName")} hint={t("whatsappNameHint")} error={errors.waName}>
            <Input id="sign-wa-name" value={waName} onChange={(e) => setWaName(e.target.value)} placeholder="sign_invitation" autoCapitalize="none" spellCheck={false} disabled={!canEdit} aria-invalid={!!errors.waName} aria-describedby="sign-wa-name-hint" />
          </Field>
          <Field id="sign-wa-lang" label={t("whatsappLanguage")} hint={t("whatsappLanguageHint")} error={errors.waLang}>
            <Input id="sign-wa-lang" value={waLang} onChange={(e) => setWaLang(e.target.value)} placeholder="en" autoCapitalize="none" spellCheck={false} disabled={!canEdit} aria-invalid={!!errors.waLang} aria-describedby="sign-wa-lang-hint" />
          </Field>
        </div>
        <p className="text-xs text-muted-foreground">{t("whatsappParams")}</p>
      </fieldset>

      <div className="space-y-1">
        <div className="text-sm font-medium text-foreground">{t("retention")}</div>
        <p className="text-sm text-foreground">{t("retentionValue", { count: settings.retention_years })}</p>
        <p className="text-xs text-muted-foreground">{t("retentionNote")}</p>
      </div>

      <Button type="submit" disabled={!canEdit || saving}>
        {saving ? <Loader2 className="animate-spin" aria-hidden /> : null}
        {t("save")}
      </Button>
    </form>
  );
}
