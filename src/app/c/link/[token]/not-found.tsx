// A personal-form address that cannot be drawn: plain, calm, and silent about why. (The page itself answers an unusable link with the same words, so this is
// only the framework's own not-found.)

import { headers } from "next/headers";

import { LinkNotValid } from "@/components/compliance/public/public-form";
import { localeFromAcceptLanguage } from "@/lib/sign/client/signer-flow";

export default async function PersonalFormNotFound() {
  const requestHeaders = await headers();
  return <LinkNotValid initialLocale={localeFromAcceptLanguage(requestHeaders.get("accept-language"))} />;
}
