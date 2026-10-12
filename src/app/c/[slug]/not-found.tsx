// A parent-form address that is no live form: plain, calm, and silent about which it was (unknown, switched off, or Compliance off for the workspace).
// There is no form to take a language from, so the page follows the browser's (Accept-Language) and offers the language choice.

import { headers } from "next/headers";

import { PublicNotAvailable } from "@/components/compliance/public/public-form";
import { localeFromAcceptLanguage } from "@/lib/sign/client/signer-flow";

export default async function PublicFormNotFound() {
  const requestHeaders = await headers();
  return <PublicNotAvailable initialLocale={localeFromAcceptLanguage(requestHeaders.get("accept-language"))} />;
}
