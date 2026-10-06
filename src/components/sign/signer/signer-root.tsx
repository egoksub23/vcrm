"use client";

// ============================================================
// Doc Sign, signing page: the language of the page (see use-language.ts). This page is shown in the
// signer's own language, so it brings its own messages and its own provider.
// ============================================================

import { useCallback, useMemo, useState } from "react";
import { NextIntlClientProvider } from "next-intl";

import { scopeOf } from "@/lib/sign/client/scope";
import { fetchView } from "@/lib/sign/client/signer-api";
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
        {initialView.envelope ? (
          <EnvelopeApp token={token} initialView={initialView} initialSessionOk={initialSessionOk} locale={locale} onLocaleChange={setLocale} product={product} />
        ) : (
          <SignerApp token={token} initialView={initialView} initialSessionOk={initialSessionOk} locale={locale} onLocaleChange={setLocale} product={product} />
        )}
      </div>
    </NextIntlClientProvider>
  );
}

interface EnvelopeAppProps {
  token: string;
  initialView: SigningView;
  initialSessionOk: boolean;
  locale: SignerLocale;
  onLocaleChange: (locale: SignerLocale) => void;
  product: string;
}

/**
 * An envelope's link (migration 171): the person's sitting. It opens ONE document at a time in the ordinary page (the fields on the page, the
 * form in parts, the review), each a page of its own for the same link (`<token>@<document id>`), and moves between them. The page remounts for
 * each document, so what is on screen is always that document's own view, and its answers are saved before the person leaves it.
 */
function EnvelopeApp({ token, initialView, initialSessionOk, locale, onLocaleChange, product }: EnvelopeAppProps) {
  const [page, setPage] = useState<{ documentId: string; view: SigningView; check: boolean }>({ documentId: initialView.envelope?.current ?? "", view: initialView, check: false });
  const go = useCallback(
    async (documentId: string, opts?: { check?: boolean }) => {
      try {
        setPage({ documentId, view: await fetchView(scopeOf(token, documentId)), check: !!opts?.check });
      } catch {
        // the page stays where it is: the person can try again
      }
    },
    [token],
  );
  const sitting = useMemo(() => ({ documentId: page.documentId, go, checkOnMount: page.check }), [page.documentId, page.check, go]);
  return (
    <SignerApp
      key={`${page.documentId}${page.check ? ":check" : ""}`}
      token={scopeOf(token, page.documentId)}
      initialView={page.view}
      initialSessionOk={initialSessionOk}
      locale={locale}
      onLocaleChange={onLocaleChange}
      product={product}
      envelope={sitting}
    />
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
