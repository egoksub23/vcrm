"use client";

// Settings > Doc Sign > General: the defaults a new document starts from, the sender name on invitations, the
// WhatsApp template used only when a sender chooses WhatsApp, and how long signed documents are kept (retention).
// The row is written with the browser client under row level security (sign.settings).

import { useEffect, useState } from "react";
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

type Errors = Partial<Record<"expiry" | "reminders" | "sender" | "waName" | "waLang" | "retention", string>>;

/** How long signed documents are kept, in years: the database allows 1 to 50. */
const RETENTION_MIN = 1;
const RETENTION_MAX = 50;

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
  const [retention, setRetention] = useState(String(settings.retention_years));
  const [pastRetention, setPastRetention] = useState<number | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);

  // how many signed documents are past their retention date (people with menu.sign can read documents, so the count is theirs to see)
  useEffect(() => {
    let live = true;
    void createClient()
      .from("sign_documents")
      .select("id", { count: "exact", head: true })
      .eq("status", "completed")
      .lt("retain_until", new Date().toISOString())
      .then(({ count, error }) => {
        if (live && !error) setPastRetention(count ?? 0);
      });
    return () => {
      live = false;
    };
  }, []);

  const save = async () => {
    const next: Errors = {};
    const expiryDays = parseWholeNumber(expiry, 1, 365);
    if (expiryDays === null) next.expiry = t("errors.expiry");
    const years = parseWholeNumber(retention, RETENTION_MIN, RETENTION_MAX);
    if (years === null) next.retention = t("errors.retention");
    const parsed = parseReminderDays(reminders);
    if ("problem" in parsed) next.reminders = t(`errors.reminders_${parsed.problem}`);
    if (sender.trim().length > 120) next.sender = t("errors.sender");
    const name = waName.trim();
    if (name && !TEMPLATE_NAME_RE.test(name)) next.waName = t("errors.waName");
    if (!TEMPLATE_LANG_RE.test(waLang.trim())) next.waLang = t("errors.waLang");
    setErrors(next);
    if (Object.keys(next).length > 0 || expiryDays === null || years === null || "problem" in parsed) return;

    setSaving(true);
    const { data, error } = await createClient()
      .from("sign_settings")
      .update({
        default_expiry_days: expiryDays,
        reminder_days: parsed.days,
        default_language: language,
        retention_years: years,
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

      <fieldset className="space-y-3 rounded-lg border border-border p-4">
        <legend className="px-1 text-sm font-semibold text-foreground">{t("retentionTitle")}</legend>
        <p className="text-sm text-muted-foreground">{t("retentionIntro")}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="sign-retention" label={t("retention")} hint={t("retentionHint")} error={errors.retention}>
            <Input id="sign-retention" inputMode="numeric" value={retention} onChange={(e) => setRetention(e.target.value)} disabled={!canEdit} aria-invalid={!!errors.retention} aria-describedby="sign-retention-hint" />
          </Field>
        </div>
        <p className="text-xs text-muted-foreground">{t("retentionEffect")}</p>
        {pastRetention !== null ? <p className="text-xs text-muted-foreground">{pastRetention === 0 ? t("retentionPastNone") : t("retentionPast", { count: pastRetention })}</p> : null}
      </fieldset>

      <Button type="submit" disabled={!canEdit || saving}>
        {saving ? <Loader2 className="animate-spin" aria-hidden /> : null}
        {t("save")}
      </Button>
    </form>
  );
}
