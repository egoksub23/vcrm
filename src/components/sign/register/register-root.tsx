"use client";

// ============================================================
// Doc Sign, registration page: the language of the page (the same provider and frame as the signing page, whose
// messages it shares, plus its own `Sign.register`) around either the form or a plain "not available" page.
// ============================================================

import { Clock, FileX } from "lucide-react";
import { NextIntlClientProvider, useTranslations } from "next-intl";

import { Shell } from "@/components/sign/signer/shell";
import { useLanguage, type SignerMessages } from "@/components/sign/signer/use-language";
import type { SignerLocale } from "@/lib/sign/client/signer-flow";
import type { RegisterView } from "@/lib/sign/service/registration";

import { RegisterForm } from "./register-form";

interface RootProps {
  initialLocale: SignerLocale;
  messages: SignerMessages;
  product: string;
}

export function RegisterRoot({ view, initialLocale, messages, product }: RootProps & { view: RegisterView }) {
  const [locale, setLocale] = useLanguage(initialLocale);
  return (
    <NextIntlClientProvider locale={locale} messages={messages[locale]} timeZone="UTC">
      <div lang={locale}>
        <Shell workspace={view.workspace} locale={locale} onLocaleChange={setLocale} product={product}>
          <RegisterForm view={view} locale={locale} />
        </Shell>
      </div>
    </NextIntlClientProvider>
  );
}

/**
 * A page that is not available: an address that is no registration page (unknown, switched off, Doc Sign off,
 * all the same), or a page that is busy. No workspace, no hint of which it was.
 */
export function RegisterNotFoundRoot({ kind = "notFound", initialLocale, messages, product }: RootProps & { kind?: "notFound" | "busy" | "unavailable" }) {
  const [locale, setLocale] = useLanguage(initialLocale);
  return (
    <NextIntlClientProvider locale={locale} messages={messages[locale]} timeZone="UTC">
      <div lang={locale}>
        <Shell workspace={null} locale={locale} onLocaleChange={setLocale} product={product}>
          <NotAvailable kind={kind} />
        </Shell>
      </div>
    </NextIntlClientProvider>
  );
}

function NotAvailable({ kind }: { kind: "notFound" | "busy" | "unavailable" }) {
  const t = useTranslations("Sign.signer");
  const r = useTranslations("Sign.register");
  const Icon = kind === "notFound" ? FileX : Clock;
  return (
    <section className="mx-auto flex max-w-md flex-col items-center gap-4 py-10 text-center" aria-labelledby="register-missing-title">
      <Icon className="size-12 text-muted-foreground" aria-hidden />
      <h1 id="register-missing-title" className="text-2xl font-semibold leading-snug">
        {kind === "busy" ? t("busy.title") : kind === "unavailable" ? r("unavailable.title") : r("notFound.title")}
      </h1>
      <p className="text-muted-foreground">{kind === "busy" ? t("busy.body") : kind === "unavailable" ? r("unavailable.body") : r("notFound.body")}</p>
    </section>
  );
}
