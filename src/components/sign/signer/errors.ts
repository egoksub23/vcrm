"use client";

// Doc Sign, signing page: the words for a failed call, by the stable code the route answered with. A code
// the page has never seen reads as a general sentence, never as the code itself.

import { useTranslations } from "next-intl";

import { SignApiError } from "@/lib/sign/client/api";

export function useErrorText(): (err: unknown) => string {
  const t = useTranslations("Sign.signer");
  return (err) => {
    const code = err instanceof SignApiError ? err.code : "generic";
    const values = { count: err instanceof SignApiError ? (err.attemptsLeft ?? 0) : 0 };
    return t.has(`errors.${code}`) ? t(`errors.${code}`, values) : t("errors.generic");
  };
}
