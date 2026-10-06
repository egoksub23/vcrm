// A link that is not valid: plain, calm, and silent about whether any document exists. There is no
// document to take a language from, so the page follows the browser's (Accept-Language) and offers the
// language choice like every other screen.

import { headers } from "next/headers";

import { loadSignerMessages } from "@/components/sign/signer/load-messages";
import { InvalidLinkRoot } from "@/components/sign/signer/signer-root";
import { localeFromAcceptLanguage } from "@/lib/sign/client/signer-flow";

export default async function SignLinkNotValid() {
  const requestHeaders = await headers();
  return (
    <InvalidLinkRoot
      initialLocale={localeFromAcceptLanguage(requestHeaders.get("accept-language"))}
      messages={await loadSignerMessages()}
      product={process.env.NEXT_PUBLIC_APP_NAME?.trim() || "Halo"}
    />
  );
}
