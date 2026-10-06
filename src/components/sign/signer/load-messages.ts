// ============================================================
// Doc Sign, signing page: the words, for the server to hand to the page. They are the `Sign.signer`
// subtree of messages/<locale>.json, laid over English so a sentence not yet translated reads in English
// instead of as a key. Each is returned as { Sign: { signer: ... } } so the components use the same
// namespace as everywhere else.
// ============================================================

import type { AbstractIntlMessages } from "next-intl";

import { mergeMessages } from "@/lib/i18n/locales";
import type { SignerLocale } from "@/lib/sign/client/signer-flow";

type Tree = { [key: string]: unknown };

const LOCALES: SignerLocale[] = ["en", "ms", "zh", "ko"];

const isTree = (v: unknown): v is Tree => typeof v === "object" && v !== null && !Array.isArray(v);

function signerSubtree(catalogue: unknown): Tree | null {
  if (!isTree(catalogue)) return null;
  const sign = catalogue.Sign;
  if (!isTree(sign)) return null;
  return isTree(sign.signer) ? sign.signer : null;
}

async function catalogue(locale: SignerLocale): Promise<unknown> {
  try {
    return (await import(`../../../../messages/${locale}.json`)).default;
  } catch {
    return null;
  }
}

/** The page's messages in every language it offers. */
export async function loadSignerMessages(): Promise<Record<SignerLocale, AbstractIntlMessages>> {
  const english = signerSubtree(await catalogue("en")) ?? {};
  const out = {} as Record<SignerLocale, AbstractIntlMessages>;
  for (const locale of LOCALES) {
    const own = locale === "en" ? english : (signerSubtree(await catalogue(locale)) ?? {});
    out[locale] = { Sign: { signer: locale === "en" ? english : mergeMessages(english, own) } } as AbstractIntlMessages;
  }
  return out;
}
