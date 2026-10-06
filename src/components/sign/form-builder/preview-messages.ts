// The words of the signer's form in one language, for "Preview as signer": the builder shows the signer's real form in the language the
// sender chooses, which need not be the language of the sender's own screen. Loaded on demand (the catalogue is large), laid over English
// so a sentence not yet translated reads in English, and returned as { Sign: { signer, signerForm } } so the components use the same
// namespaces as on the signing page.

import type { AbstractIntlMessages } from "next-intl";

import { mergeMessages } from "@/lib/i18n/locales";
import type { SignLocale } from "@/lib/sign/types";

type Tree = { [key: string]: unknown };
const isTree = (v: unknown): v is Tree => typeof v === "object" && v !== null && !Array.isArray(v);

function subtree(catalogue: unknown, name: string): Tree {
  if (!isTree(catalogue) || !isTree(catalogue.Sign)) return {};
  const part = catalogue.Sign[name];
  return isTree(part) ? part : {};
}

async function catalogue(locale: SignLocale): Promise<unknown> {
  try {
    return (await import(`../../../../messages/${locale}.json`)).default;
  } catch {
    return null;
  }
}

const cache = new Map<SignLocale, Promise<AbstractIntlMessages>>();

export function loadPreviewMessages(locale: SignLocale): Promise<AbstractIntlMessages> {
  let found = cache.get(locale);
  if (!found) {
    found = (async () => {
      const english = await catalogue("en");
      const own = locale === "en" ? english : await catalogue(locale);
      const pick = (name: string) => (locale === "en" ? subtree(english, name) : mergeMessages(subtree(english, name), subtree(own, name)));
      return { Sign: { signer: pick("signer"), signerForm: pick("signerForm") } } as AbstractIntlMessages;
    })();
    cache.set(locale, found);
  }
  return found;
}
