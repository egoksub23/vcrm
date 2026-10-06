"use client";

// ============================================================
// Doc Sign, signing page, forms in parts: what every piece of the form screens shares. The language the
// form's own texts (titles, labels, options) are picked in, the words for a code, and the clock that
// keeps "Saved 2 minutes ago" true. Everything the page itself says comes from `Sign.signerForm`.
// ============================================================

import { createContext, useContext, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";

import { pick } from "@/lib/sign/forms/text";
import type { L10n } from "@/lib/sign/forms/types";
import { problemKey, type FormRejection } from "@/lib/sign/client/signer-form";
import type { SignerLocale } from "@/lib/sign/client/signer-flow";

const FormUi = createContext<{ locale: SignerLocale }>({ locale: "en" });
export const FormUiProvider = FormUi.Provider;

export const useFormLocale = (): SignerLocale => useContext(FormUi).locale;

/** The form's own text in the language of the page, or English where the author left it empty. */
export function useFormText(): (text: L10n | undefined) => string {
  const { locale } = useContext(FormUi);
  return (text) => pick(text, locale);
}

/** The words for a rejection: its reason, with the number it carries (a limit), or the general sentence for a reason the page has never seen. */
export function useProblemText(): (rejection: FormRejection | null | undefined) => string | null {
  const t = useTranslations("Sign.signerForm");
  return (rejection) => {
    if (!rejection) return null;
    return t(`problems.${problemKey(rejection.code)}`, { detail: rejection.detail ?? "" });
  };
}

// ---- the clock -------------------------------------------------------------------------------------------------

let tick = 0;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    tick = Date.now();
    timer = setInterval(() => {
      tick = Date.now();
      listeners.forEach((l) => l());
    }, 30_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const snapshot = (): number => (tick === 0 ? (tick = Date.now()) : tick);

/** The time now, in ms, moved on every half minute. Zero while the server renders, so the first paint says nothing about "ago". */
export function useNow(): number {
  return useSyncExternalStore(subscribe, snapshot, () => 0);
}
