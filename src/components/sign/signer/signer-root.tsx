"use client";

// ============================================================
// Doc Sign, signing page: the language of the page (see use-language.ts). This page is shown in the
// signer's own language, so it brings its own messages and its own provider.
// ============================================================

import { NextIntlClientProvider } from "next-intl";

import type { SignerLocale } from "@/lib/sign/client/signer-flow";
import type { SigningView } from "@/lib/sign/service/signing";

import { InvalidLink } from "./end-screens";
import { Shell } from "./shell";
import { SignerApp } from "./signer-app";
import { useLanguage, type SignerMessages } from "./use-language";

export type { SignerMessages };

interface SignerRootProps {
  token: string;
  initialView: SigningView;
  initialSessionOk: boolean;
  initialLocale: SignerLocale;
  messages: SignerMessages;
  product: string;
}

export function SignerRoot({ token, initialView, initialSessionOk, initialLocale, messages, product }: SignerRootProps) {
  const [locale, setLocale] = useLanguage(initialLocale);
  return (
    <NextIntlClientProvider locale={locale} messages={messages[locale]} timeZone="UTC">
      <div lang={locale}>
        <SignerApp token={token} initialView={initialView} initialSessionOk={initialSessionOk} locale={locale} onLocaleChange={setLocale} product={product} />
      </div>
    </NextIntlClientProvider>
  );
}

interface InvalidRootProps {
  /** Too many requests from this address, rather than a link that is not valid. */
  busy?: boolean;
  initialLocale: SignerLocale;
  messages: SignerMessages;
  product: string;
}

/** The page for a link that is not valid or a page that is busy: no workspace, no document. */
export function InvalidLinkRoot({ busy, initialLocale, messages, product }: InvalidRootProps) {
  const [locale, setLocale] = useLanguage(initialLocale);
  return (
    <NextIntlClientProvider locale={locale} messages={messages[locale]} timeZone="UTC">
      <div lang={locale}>
        <Shell workspace={null} locale={locale} onLocaleChange={setLocale} product={product}>
          <InvalidLink busy={busy} />
        </Shell>
      </div>
    </NextIntlClientProvider>
  );
}
