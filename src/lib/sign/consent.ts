// ============================================================
// The wording a signer agrees to before signing. A workspace can set its own per language (Doc Sign
// settings); otherwise this default is used. Each wording has a version, recorded with the signer's
// agreement, so the record shows exactly which words were agreed to.
//
// The default wording is a starting point and has NOT had a legal read for Malaysian law: it is on the
// list of things counsel must see before merchant contracts are signed with it (docs/vircle-sign-plan.md).
// ============================================================

import { createHash } from "node:crypto";

import type { SignLocale } from "./types";

export const DEFAULT_CONSENT: Record<SignLocale, string> = {
  en: "I agree to use electronic records and signatures for this document. I confirm that I have read it, that what I enter is correct, and that my electronic signature has the same effect as a handwritten signature to the extent the law allows. If I prefer a paper copy, I will tell the sender.",
  ms: "Saya bersetuju menggunakan rekod dan tandatangan elektronik untuk dokumen ini. Saya mengesahkan bahawa saya telah membacanya, maklumat yang saya masukkan adalah betul, dan tandatangan elektronik saya mempunyai kesan yang sama seperti tandatangan tulisan tangan setakat yang dibenarkan oleh undang-undang. Jika saya lebih suka salinan bercetak, saya akan memaklumkan kepada penghantar.",
  zh: "我同意就本文件使用电子记录和电子签名。我确认已阅读本文件，所填内容准确无误，并且在法律允许的范围内，我的电子签名与手写签名具有同等效力。如需纸质副本，我会告知发件人。",
  ko: "저는 이 문서에 전자 기록과 전자 서명을 사용하는 데 동의합니다. 문서를 읽었고 입력한 내용이 정확하며, 법이 허용하는 범위에서 제 전자 서명이 수기 서명과 같은 효력을 가진다는 점을 확인합니다. 종이 사본을 원하면 발신자에게 알리겠습니다.",
};

export interface Consent {
  /** Stored with the signer's agreement. */
  version: string;
  text: string;
  custom: boolean;
}

/** The wording and version to show for a document in `locale`, given the workspace's own texts if it set any. */
export function consentFor(custom: Record<string, string> | null | undefined, locale: SignLocale): Consent {
  const own = custom?.[locale]?.trim();
  if (own) {
    return { text: own, custom: true, version: `custom-${locale}-${createHash("sha256").update(own, "utf8").digest("hex").slice(0, 10)}` };
  }
  return { text: DEFAULT_CONSENT[locale] ?? DEFAULT_CONSENT.en, custom: false, version: `default-v1-${locale in DEFAULT_CONSENT ? locale : "en"}` };
}
