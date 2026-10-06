// ============================================================
// The wording a person agrees to on a registration page: that the workspace keeps what they enter and uses it
// to process their registration, which includes emailing them the document. A form can set its own per
// language (Settings > Doc Sign > Registration forms); otherwise this default is used. The wording has a
// version, stored with every submission, so the record shows exactly which words were agreed to.
//
// This is NOT the signing consent (lib/sign/consent.ts): that is agreed on the signing page, later, by the
// person who signs. `{workspace}` is replaced with the workspace's name when the page is drawn; the version is
// taken from the wording before the replacement, so it does not change with the name.
//
// The default wording is a starting point and has NOT had a legal read for Malaysian law (PDPA 2010): it is on
// the list of things counsel must see before the page is used with real applicants.
// ============================================================

import { createHash } from "node:crypto";

import type { SignLocale } from "../types";
import type { Wording } from "./types";

export const DEFAULT_REGISTRATION_CONSENT: Record<SignLocale, string> = {
  en: "I agree that {workspace} may keep the details I enter here and use them only to process my registration, including emailing me the registration document at the address I entered. I can ask to see or correct my details at any time.",
  ms: "Saya bersetuju {workspace} menyimpan butiran yang saya masukkan di sini dan menggunakannya hanya untuk memproses pendaftaran saya, termasuk menghantar dokumen pendaftaran ke alamat e-mel yang saya berikan. Saya boleh meminta untuk melihat atau membetulkan butiran saya pada bila-bila masa.",
  zh: "我同意 {workspace} 保存我在此填写的资料，并仅用于办理我的注册，包括将注册文件发送到我填写的电子邮箱。我可以随时要求查看或更正我的资料。",
  ko: "저는 {workspace}이(가) 제가 여기에 입력한 정보를 보관하고, 제 등록을 처리하는 데에만 사용하며, 여기에는 제가 입력한 이메일 주소로 등록 문서를 보내는 것이 포함된다는 점에 동의합니다. 저는 언제든지 제 정보를 열람하거나 정정해 달라고 요청할 수 있습니다.",
};

export interface RegistrationConsent {
  /** With the workspace's name filled in: what the person reads. */
  text: string;
  custom: boolean;
  /** Stored with the submission. */
  version: string;
}

const fill = (template: string, workspace: string): string => template.replace(/\{workspace\}/g, workspace);

/** The wording and version for `locale`: the form's own text if it set one for that language, else the product's. */
export function registrationConsentFor(custom: Wording | null | undefined, locale: SignLocale, workspace: string): RegistrationConsent {
  const own = custom?.[locale]?.trim();
  if (own) {
    return { text: fill(own, workspace), custom: true, version: `custom-${locale}-${createHash("sha256").update(own, "utf8").digest("hex").slice(0, 10)}` };
  }
  return { text: fill(DEFAULT_REGISTRATION_CONSENT[locale] ?? DEFAULT_REGISTRATION_CONSENT.en, workspace), custom: false, version: `default-v1-${locale in DEFAULT_REGISTRATION_CONSENT ? locale : "en"}` };
}
