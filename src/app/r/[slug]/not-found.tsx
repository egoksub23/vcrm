// A registration address that is no live page: plain, calm, and silent about which it was (unknown, switched
// off, or Doc Sign off for the workspace). There is no form to take a language from, so the page follows the
// browser's (Accept-Language) and offers the language choice like every other screen.

import { headers } from "next/headers";

import { loadSignerMessages } from "@/components/sign/signer/load-messages";
import { RegisterNotFoundRoot } from "@/components/sign/register/register-root";
import { localeFromAcceptLanguage } from "@/lib/sign/client/signer-flow";

export default async function RegisterNotFound() {
  const requestHeaders = await headers();
  return (
    <RegisterNotFoundRoot
      initialLocale={localeFromAcceptLanguage(requestHeaders.get("accept-language"))}
      messages={await loadSignerMessages({ register: true })}
      product={process.env.NEXT_PUBLIC_APP_NAME?.trim() || "Halo"}
    />
  );
}
