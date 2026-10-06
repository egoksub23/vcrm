"use client";

// ============================================================
// Doc Sign, signing page: the language of the page. The global language of the app is the signed-in
// person's, which a signer is not; this page is shown in the signer's own language (the document's, or
// ?lang=), so it brings its own messages and its own provider. All four languages are sent with the page
// (a few kilobytes each), so changing language is instant and works with no connection; the choice is
// kept in the address so a refresh keeps it.
// ============================================================

import { useState } from "react";
import { NextIntlClientProvider, type AbstractIntlMessages } from "next-intl";

import type { SignerLocale } from "@/lib/sign/client/signer-flow";
import type { SigningView } from "@/lib/sign/service/signing";

import { InvalidLink } from "./end-screens";
import { Shell } from "./shell";
import { SignerApp } from "./signer-app";

export type SignerMessages = Record<SignerLocale, AbstractIntlMessages>;

function useLanguage(initial: SignerLocale): [SignerLocale, (next: SignerLocale) => void] {
  const [locale, setLocale] = useState(initial);
  const change = (next: SignerLocale) => {
    setLocale(next);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("lang", next);
      window.history.replaceState(window.history.state, "", url.toString());
    } catch {
      // the address is only a convenience for a refresh
    }
  };
  return [locale, change];
}

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
