"use client";

// Settings > Doc Sign > Consent wording: the words a signer agrees to before signing, per language. The default
// wording is shown; writing your own replaces it for that language. Each wording has a version that is recorded
// with the signer's agreement, so the record shows which words were agreed to (the version is made by the server
// from the text: changing the words changes the version, see lib/sign/consent.ts).

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useCapability } from "@/hooks/use-can";
import { CONSENT_MAX_CHARS, withConsentText } from "@/lib/sign/client/admin-settings";
import { createClient } from "@/lib/supabase/client";
import { SIGN_LOCALES, type SignLocale, type SignSettingsRow } from "@/lib/sign/types";

import type { SignSettingsData } from "./use-sign-settings";

export function ConsentSection({ data, onSaved }: { data: SignSettingsData; onSaved: () => void }) {
  const t = useTranslations("Sign.admin.consent");
  return (
    <div className="max-w-3xl space-y-5">
      <p className="text-sm text-muted-foreground">{t("intro")}</p>
      {SIGN_LOCALES.map((locale) => (
        // saving a language starts only that editor again, from what is stored; the others keep unsaved edits
        <ConsentEditor key={`${locale}:${data.settings.consent_texts?.[locale] ?? ""}`} locale={locale} data={data} onSaved={onSaved} />
      ))}
    </div>
  );
}

function ConsentEditor({ locale, data, onSaved }: { locale: SignLocale; data: SignSettingsData; onSaved: () => void }) {
  const t = useTranslations("Sign.admin.consent");
  const tLang = useTranslations("Sign.admin.languages");
  const canEdit = useCapability("sign.settings");
  const { settings } = data;
  const stored = settings.consent_texts?.[locale]?.trim() ?? "";
  const defaultText = data.consentDefaults[locale].text;

  const [own, setOwn] = useState(stored !== "");
  const [text, setText] = useState(stored || defaultText);
  const [saving, setSaving] = useState(false);

  const info = data.consent[locale];
  const next = own ? text.trim() : "";
  const dirty = next !== stored;
  const emptyOwn = own && next === "";

  const toggle = (on: boolean) => {
    setOwn(on);
    // starting your own wording starts from the default text, which is easier to adjust than a blank box
    if (on && text.trim() === "") setText(defaultText);
  };

  const save = async () => {
    if (emptyOwn) return;
    setSaving(true);
    const { error } = await createClient()
      .from("sign_settings")
      .update({ consent_texts: withConsentText(settings.consent_texts, locale, next) } satisfies Partial<SignSettingsRow>)
      .eq("id", settings.id);
    setSaving(false);
    if (error) {
      toast.error(t("saveFailed"));
      return;
    }
    toast.success(t("saved"));
    onSaved();
  };

  const id = `sign-consent-${locale}`;
  return (
    <section className="space-y-3 rounded-lg border border-border p-4" aria-labelledby={`${id}-title`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${id}-title`} className="text-sm font-semibold text-foreground">
          {tLang(locale)}
        </h3>
        <span className="text-xs text-muted-foreground">
          {info.custom ? t("customInUse") : t("defaultInUse")} · {t("version", { version: info.version })}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <Switch id={`${id}-own`} checked={own} onCheckedChange={toggle} disabled={!canEdit} aria-label={t("useOwn")} />
        <label htmlFor={`${id}-own`} className="text-sm text-foreground">
          {t("useOwn")}
        </label>
      </div>

      <Textarea
        id={id}
        value={own ? text : defaultText}
        onChange={(e) => setText(e.target.value)}
        readOnly={!own}
        maxLength={CONSENT_MAX_CHARS}
        rows={4}
        aria-label={t("textLabel", { language: tLang(locale) })}
        aria-invalid={emptyOwn}
        className={own ? undefined : "bg-muted/40 text-muted-foreground"}
      />
      <p className="text-xs text-muted-foreground">{own ? t("ownHint", { max: CONSENT_MAX_CHARS }) : t("defaultHint")}</p>
      {emptyOwn ? (
        <p role="alert" className="text-xs text-destructive">
          {t("emptyOwn")}
        </p>
      ) : null}

      <Button type="button" size="sm" disabled={!canEdit || !dirty || emptyOwn || saving} onClick={() => void save()}>
        {saving ? <Loader2 className="animate-spin" aria-hidden /> : null}
        {t("save")}
      </Button>
    </section>
  );
}
