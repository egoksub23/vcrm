"use client";

// ============================================================
// Doc Sign, public pages: the language of the page. The global language of the app is the signed-in
// person's, which a signer or a person checking a document is not; these pages are shown in their own
// language (the document's, or ?lang=), so each brings its own messages and its own provider. All four
// languages are sent with the page (a few kilobytes each), so changing language is instant and works with
// no connection; the choice is kept in the address so a refresh keeps it.
//
// A module of its own so the verify page can use it without loading the whole signing app.
// ============================================================

import { useState } from "react";
import type { AbstractIntlMessages } from "next-intl";

import type { SignerLocale } from "@/lib/sign/client/signer-flow";

export type SignerMessages = Record<SignerLocale, AbstractIntlMessages>;

export function useLanguage(initial: SignerLocale): [SignerLocale, (next: SignerLocale) => void] {
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
