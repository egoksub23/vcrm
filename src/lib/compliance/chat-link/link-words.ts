// ============================================================
// Compliance requests, the personal closure form (/c/link/<token>): the words that are particular to it, in English, Bahasa Melayu, Chinese and Korean. Pure;
// browser-safe. Everything else on the page (the closure warning, the ticks, the bank section, the declaration, the confirmation and "what happens next") is
// the public closure form's own wording (lib/compliance/public/words.ts), so the two forms say the same things.
//
// The page NEVER says which of the reasons a link does not work (never opened, used, withdrawn, replaced, expired, unknown): there is one calm page.
//
// [NATIVE REVIEW] The Malay, Chinese and Korean wording was written for this build and has not been read by a native speaker.
// ============================================================

import type { CustomerLocale } from "../types";

export interface LinkWords {
  /** The email the parent TYPES (there is no emailed code on this form). */
  email: { label: string; help: string };
  /** The registered phone number, shown masked and not editable: it comes from the chat. */
  phone: { label: string; help: string };
  /** The one page for a link that does not work, whatever the reason. */
  invalid: { title: string; body: string };
  /** The two steps shown at the top (there is no step to confirm an email). */
  step: { form: string; done: string };
}

const EN: LinkWords = {
  email: { label: "Your email address", help: "We will use it to write to you about this request. Please check that it is correct." },
  phone: { label: "Registered phone number", help: "This is the number you are chatting with us on. It cannot be changed here." },
  invalid: { title: "This link is not valid any more", body: "Please contact support." },
  step: { form: "Your request", done: "Done" },
};

const MS: LinkWords = {
  email: { label: "Alamat e-mel anda", help: "Kami akan menggunakannya untuk menghubungi anda tentang permohonan ini. Sila pastikan ia betul." },
  phone: { label: "Nombor telefon berdaftar", help: "Ini ialah nombor yang anda gunakan untuk berbual dengan kami. Ia tidak boleh diubah di sini." },
  invalid: { title: "Pautan ini tidak sah lagi", body: "Sila hubungi sokongan." },
  step: { form: "Permohonan anda", done: "Selesai" },
};

const ZH: LinkWords = {
  email: { label: "您的电子邮件地址", help: "我们会通过此地址就本申请与您联系，请确认地址无误。" },
  phone: { label: "注册手机号码", help: "这是您与我们聊天所用的号码，无法在此更改。" },
  invalid: { title: "此链接已失效", body: "请联系客服支持。" },
  step: { form: "您的申请", done: "完成" },
};

const KO: LinkWords = {
  email: { label: "이메일 주소", help: "이 요청과 관련하여 연락드릴 때 사용합니다. 주소가 맞는지 확인해 주세요." },
  phone: { label: "등록된 전화번호", help: "저희와 채팅 중인 번호입니다. 여기에서는 변경할 수 없습니다." },
  invalid: { title: "이 링크는 더 이상 유효하지 않습니다", body: "고객 지원팀에 문의해 주세요." },
  step: { form: "요청서", done: "완료" },
};

export const LINK_WORDS: Record<CustomerLocale, LinkWords> = { en: EN, ms: MS, zh: ZH, ko: KO };

export const linkWords = (locale: CustomerLocale): LinkWords => LINK_WORDS[locale] ?? EN;
