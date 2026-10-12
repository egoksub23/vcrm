"use client";

// ============================================================
// Settings > Compliance > Public forms (compliance.manage): the account closure form and the fund withdrawal form that parents fill in at /c/<slug>,
// replacing the old Airtable form. For each: whether it is on, its address (random; "new address" retires the old one at once), an extra notice shown
// above the form in each language, Turnstile (only if the operator has set both keys), the largest amount a withdrawal accepts, and the list of banks.
// A form works only while the operator's `compliance` flag is on for the workspace AND the form is on. A phone number change has no public form.
// ============================================================

import { Copy, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { PublicFormSettings } from "@/lib/compliance/public/settings-types";
import type { CustomerLocale } from "@/lib/compliance/types";
import { LOCALES } from "@/lib/compliance/types";

import { getPublicForms, patchPublicForm } from "./api";
import { errorKey } from "./helpers";
import { Notice } from "./parts";

/** The address a form is shared at, on this site. */
export const formUrl = (origin: string, slug: string): string => `${origin.replace(/\/+$/, "")}/c/${slug}`;

/** Parse the maximum amount a person typed: a positive number with at most two decimals, else null. */
export function parseMaxAmount(v: string): number | null {
  const t = v.trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const n = Number(t);
  return n > 0 && n <= 100_000_000 ? n : null;
}

export function PublicFormsSettings() {
  const t = useTranslations("Compliance.settings.publicForms");
  const tErr = useTranslations("Compliance.errors");
  const [forms, setForms] = useState<PublicFormSettings[] | null>(null);
  const [turnstileAvailable, setTurnstileAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await getPublicForms();
    if (!res.ok) {
      setError(errorKey(res.code));
      return;
    }
    setError(null);
    setForms(res.data.forms);
    setTurnstileAvailable(res.data.turnstileAvailable);
  }, []);
  useEffect(() => {
    // load-on-mount fetch whose result sets state
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  return (
    <section aria-labelledby="cmp-pf-title" className="space-y-3">
      <div>
        <h3 id="cmp-pf-title" className="text-base font-semibold text-foreground">{t("title")}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{t("intro")}</p>
      </div>
      {error ? <Notice tone="danger">{tErr(error)}</Notice> : null}
      {forms === null && !error ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {t("loading")}
        </p>
      ) : null}
      {forms?.map((f) => (
        <PublicFormCard key={`${f.typeKey}-${f.slug}-${f.enabled}`} form={f} turnstileAvailable={turnstileAvailable} onSaved={(all, ts) => { setForms(all); setTurnstileAvailable(ts); }} />
      ))}
    </section>
  );
}

export function PublicFormCard({
  form,
  turnstileAvailable,
  onSaved,
  origin,
}: {
  form: PublicFormSettings;
  turnstileAvailable: boolean;
  onSaved: (forms: PublicFormSettings[], turnstileAvailable: boolean) => void;
  /** For tests: the site's address. */
  origin?: string;
}) {
  const t = useTranslations("Compliance.settings.publicForms");
  const tErr = useTranslations("Compliance.errors");
  const tc = useTranslations("Compliance");
  const locale = useLocale();
  const [enabled, setEnabled] = useState(form.enabled);
  const [notice, setNotice] = useState<Record<CustomerLocale, string>>({ en: form.notice.en ?? "", ms: form.notice.ms ?? "", zh: form.notice.zh ?? "", ko: form.notice.ko ?? "" });
  const [turnstile, setTurnstile] = useState(form.turnstile);
  const [maxAmount, setMaxAmount] = useState(String(form.maxAmount));
  const [banks, setBanks] = useState((form.banks ?? []).join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const here = origin ?? (typeof window === "undefined" ? "" : window.location.origin);
  const url = form.slug ? formUrl(here, form.slug) : null;
  const max = parseMaxAmount(maxAmount);
  const closure = form.typeKey === "closure";
  const idp = `cmp-pf-${form.typeKey}`;

  const run = async (patch: Parameters<typeof patchPublicForm>[1]) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    const res = await patchPublicForm(form.typeKey, patch);
    setBusy(false);
    if (!res.ok) {
      setError(errorKey(res.code));
      return;
    }
    setSaved(true);
    onSaved(res.data.forms, res.data.turnstileAvailable);
  };

  const save = () =>
    run({
      enabled,
      notice,
      turnstile: turnstileAvailable ? turnstile : false,
      ...(closure ? {} : max !== null ? { maxAmount: max } : {}),
      banks: banks.trim() === "" ? null : banks,
    });

  return (
    <article className="space-y-4 rounded-xl border border-border bg-card p-4" aria-labelledby={`${idp}-title`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={`${idp}-title`} className="text-base font-semibold text-foreground">{t(`types.${form.typeKey}`)}</h4>
        <span className={form.enabled ? "rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-[light-dark(#047857,#6ee7b7)]" : "rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"}>
          {form.enabled ? t("isOn") : t("isOff")}
        </span>
      </div>
      {!form.ready ? <Notice tone="warn">{t("notReady")}</Notice> : null}

      <label className="flex items-start gap-2 text-sm">
        <input id={`${idp}-enabled`} type="checkbox" className="mt-0.5 size-4 accent-[var(--primary)]" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={!form.ready && !form.enabled} />
        <span>
          <span className="font-medium">{t("enable")}</span>
          <span className="block text-xs text-muted-foreground">{t("enableHint")}</span>
        </span>
      </label>

      <div>
        <p className="mb-1 text-sm font-medium">{t("address")}</p>
        {url ? (
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1 text-xs" data-form-url>{url}</code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard?.writeText(url).then(() => setCopied(true)).catch(() => undefined);
              }}
            >
              <Copy className="size-3.5" aria-hidden />
              {copied ? t("copied") : t("copy")}
            </Button>
            <a href={url} target="_blank" rel="noreferrer" className="inline-flex h-7 items-center gap-1 rounded-lg border border-border px-2.5 text-xs font-medium hover:bg-muted">
              <ExternalLink className="size-3.5" aria-hidden />
              {t("open")}
            </a>
            <Button type="button" variant="ghost" size="sm" onClick={() => void run({ regenerateSlug: true })} disabled={busy}>
              <RefreshCw className="size-3.5" aria-hidden />
              {t("newAddress")}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("noAddress")}</p>
        )}
        {url ? <p className="mt-1 text-xs text-muted-foreground">{t("newAddressHint")}</p> : null}
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("notice")}</legend>
        <p className="text-xs text-muted-foreground">{t("noticeHint")}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {LOCALES.map((l) => (
            <div key={l}>
              <label htmlFor={`${idp}-notice-${l}`} className="mb-1 block text-xs font-medium text-muted-foreground">{t(`languages.${l}`)}</label>
              <Textarea id={`${idp}-notice-${l}`} value={notice[l]} onChange={(e) => setNotice({ ...notice, [l]: e.target.value })} rows={3} maxLength={2000} lang={l} />
            </div>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex items-start gap-2 text-sm">
          <input id={`${idp}-turnstile`} type="checkbox" className="mt-0.5 size-4 accent-[var(--primary)]" checked={turnstile && turnstileAvailable} disabled={!turnstileAvailable} onChange={(e) => setTurnstile(e.target.checked)} />
          <span>
            <span className="font-medium">{t("turnstile")}</span>
            <span className="block text-xs text-muted-foreground">{turnstileAvailable ? t("turnstileHint") : t("turnstileMissing")}</span>
          </span>
        </label>
        {closure ? null : (
          <div>
            <label htmlFor={`${idp}-max`} className="mb-1 block text-sm font-medium">{t("maxAmount")}</label>
            <Input id={`${idp}-max`} inputMode="decimal" value={maxAmount} onChange={(e) => setMaxAmount(e.target.value)} aria-invalid={max === null || undefined} />
            <p className="mt-1 text-xs text-muted-foreground">{max === null ? t("maxAmountInvalid") : t("maxAmountHint", { amount: max.toLocaleString(locale) })}</p>
          </div>
        )}
      </div>

      <div>
        <label htmlFor={`${idp}-banks`} className="mb-1 block text-sm font-medium">{t("banks")}</label>
        <Textarea id={`${idp}-banks`} value={banks} onChange={(e) => setBanks(e.target.value)} rows={4} placeholder={t("banksPlaceholder")} />
        <p className="mt-1 text-xs text-muted-foreground">{t("banksHint")}</p>
      </div>

      {error ? <Notice tone="danger">{tErr(error)}</Notice> : null}
      <div className="flex items-center gap-3">
        <Button onClick={() => void save()} disabled={busy || (!closure && max === null)}>
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {tc("save")}
        </Button>
        {saved ? <span role="status" className="text-sm text-muted-foreground">{t("saved")}</span> : null}
      </div>
    </article>
  );
}
