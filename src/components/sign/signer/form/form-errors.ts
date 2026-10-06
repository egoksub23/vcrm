"use client";

// Doc Sign, signing page, forms in parts: the words for a failed call that only a form has (an answer too
// long for where it prints, a file the server turned down). Null for any other failure: the page's own
// words (errors.ts) say those.

import { useTranslations } from "next-intl";

import { SignApiError } from "@/lib/sign/client/api";
import { FORM_ERROR_CODES } from "@/lib/sign/client/signer-form";

export function useFormErrorText(): (err: unknown) => string | null {
  const t = useTranslations("Sign.signerForm");
  return (err) => {
    if (!(err instanceof SignApiError) || !(FORM_ERROR_CODES as readonly string[]).includes(err.code)) return null;
    return t(`errors.${err.code}`);
  };
}
