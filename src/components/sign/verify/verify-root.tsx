"use client";

// ============================================================
// Doc Sign, verify page: the language of the page (same provider and frame as the signing page, whose
// messages it shares) around either the facts of a signed document or the plain "not found" page.
// ============================================================

import { Clock, FileX } from "lucide-react";
import { NextIntlClientProvider, useTranslations } from "next-intl";

import { Shell } from "@/components/sign/signer/shell";
import { useLanguage, type SignerMessages } from "@/components/sign/signer/use-language";
import type { SignerLocale } from "@/lib/sign/client/signer-flow";
import type { VerifyView } from "@/lib/sign/service/verify";

import { VerifyApp } from "./verify-view";

interface RootProps {
  initialLocale: SignerLocale;
  messages: SignerMessages;
  product: string;
}

export function VerifyRoot({ view, initialLocale, messages, product }: RootProps & { view: VerifyView }) {
  const [locale, setLocale] = useLanguage(initialLocale);
  return (
    <NextIntlClientProvider locale={locale} messages={messages[locale]} timeZone="UTC">
      <div lang={locale}>
        <Shell workspace={view.workspace} locale={locale} onLocaleChange={setLocale} product={product}>
          <VerifyApp view={view} />
        </Shell>
      </div>
    </NextIntlClientProvider>
  );
}

/** An address that is not a signed document (or a page that is busy): no workspace, no hint of which it was. */
export function VerifyNotFoundRoot({ busy, initialLocale, messages, product }: RootProps & { busy?: boolean }) {
  const [locale, setLocale] = useLanguage(initialLocale);
  return (
    <NextIntlClientProvider locale={locale} messages={messages[locale]} timeZone="UTC">
      <div lang={locale}>
        <Shell workspace={null} locale={locale} onLocaleChange={setLocale} product={product}>
          <NotFound busy={busy} />
        </Shell>
      </div>
    </NextIntlClientProvider>
  );
}

function NotFound({ busy }: { busy?: boolean }) {
  const t = useTranslations("Sign.signer");
  const v = useTranslations("Sign.verify");
  const Icon = busy ? Clock : FileX;
  return (
    <section className="mx-auto flex max-w-md flex-col items-center gap-4 py-10 text-center" aria-labelledby="verify-missing-title">
      <Icon className="size-12 text-muted-foreground" aria-hidden />
      <h1 id="verify-missing-title" className="text-2xl font-semibold leading-snug">
        {busy ? t("busy.title") : v("notFound.title")}
      </h1>
      <p className="text-muted-foreground">{busy ? t("busy.body") : v("notFound.body")}</p>
    </section>
  );
}
