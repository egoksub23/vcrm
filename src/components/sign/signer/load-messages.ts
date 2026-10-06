// ============================================================
// Doc Sign, signing page: the words, for the server to hand to the page. They are the `Sign.signer` and
// `Sign.signerForm` (the form in parts) subtrees of messages/<locale>.json, laid over English so a sentence
// not yet translated reads in English instead of as a key. Each is returned as
// { Sign: { signer: ..., signerForm: ... } } so the components use the same namespaces as everywhere else,
// and one provider carries both.
// ============================================================

import type { AbstractIntlMessages } from "next-intl";

import { mergeMessages } from "@/lib/i18n/locales";
import type { SignerLocale } from "@/lib/sign/client/signer-flow";

type Tree = { [key: string]: unknown };

const LOCALES: SignerLocale[] = ["en", "ms", "zh", "ko"];

const isTree = (v: unknown): v is Tree => typeof v === "object" && v !== null && !Array.isArray(v);

function signSubtree(catalogue: unknown, name: "signer" | "signerForm" | "verify" | "register"): Tree | null {
  if (!isTree(catalogue)) return null;
  const sign = catalogue.Sign;
  if (!isTree(sign)) return null;
  const tree = sign[name];
  return isTree(tree) ? tree : null;
}

async function catalogue(locale: SignerLocale): Promise<unknown> {
  try {
    return (await import(`../../../../messages/${locale}.json`)).default;
  } catch {
    return null;
  }
}

/**
 * The page's messages in every language it offers. The verify page (the QR code on a certificate) and the
 * registration page share the signing page's frame and error words, and add their own `Sign.verify` or
 * `Sign.register` subtree on request, so the signing page does not carry words it never shows.
 */
export async function loadSignerMessages(opts: { verify?: boolean; register?: boolean } = {}): Promise<Record<SignerLocale, AbstractIntlMessages>> {
  const en = await catalogue("en");
  const english = signSubtree(en, "signer") ?? {};
  const englishForm = signSubtree(en, "signerForm") ?? {};
  const englishVerify = signSubtree(en, "verify") ?? {};
  const englishRegister = signSubtree(en, "register") ?? {};
  const out = {} as Record<SignerLocale, AbstractIntlMessages>;
  for (const locale of LOCALES) {
    const other = locale === "en" ? en : await catalogue(locale);
    const signer = locale === "en" ? english : mergeMessages(english, signSubtree(other, "signer") ?? {});
    const signerForm = locale === "en" ? englishForm : mergeMessages(englishForm, signSubtree(other, "signerForm") ?? {});
    const sign: Tree = { signer, signerForm };
    if (opts.verify) sign.verify = locale === "en" ? englishVerify : mergeMessages(englishVerify, signSubtree(other, "verify") ?? {});
    if (opts.register) sign.register = locale === "en" ? englishRegister : mergeMessages(englishRegister, signSubtree(other, "register") ?? {});
    out[locale] = { Sign: sign } as AbstractIntlMessages;
  }
  return out;
}
