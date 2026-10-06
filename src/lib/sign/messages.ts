// ============================================================
// The words of the messages Doc Sign sends: invitations, reminders, codes and outcomes. Signers are
// outside the workspace and read these in the document's language (English, Bahasa Melayu, Chinese or
// Korean), so they are written here rather than in Halo's own message files. Pure: each function
// returns the subject, an HTML body and a plain-text body.
// ============================================================

import type { SignLocale, SignMode } from "./types";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface Words {
  invitationSubject: string; // {sender} {title}
  invitationFillSubject: string;
  invitationIntro: string; // {name} {sender} {workspace} {title}
  invitationIntroFill: string;
  invitationButton: string;
  invitationButtonFill: string;
  expires: string; // {date}
  codeNote: string;
  messageFrom: string; // {sender}
  notExpecting: string; // {sender}
  linkIsPersonal: string;
  reminderSubject: string; // {title}
  reminderIntro: string; // {name} {title}
  reminderNewLink: string;
  reminderPartsOne: string; // {parts}
  reminderPartsMany: string; // {count} {parts}
  codeSubject: string;
  codeIntro: string; // {title}
  codeValid: string;
  codeIgnore: string;
  completedSubject: string; // {title}
  completedIntro: string; // {name} {title}
  completedAttached: string;
  completedLink: string;
  declinedSubject: string; // {title}
  declinedIntro: string; // {name} {title}
  declinedReason: string; // {reason}
  expiredSubject: string; // {title}
  expiredIntro: string; // {title}
  voidedSubject: string; // {title}
  voidedIntro: string; // {title}
  forwardSubject: string; // {forwarder} {title}
  forwardIntroTurn: string; // {name} {forwarder} {sender} {workspace} {title}
  forwardIntroPart: string; // {name} {forwarder} {sender} {workspace} {title} {part}
  forwardConsentTurn: string;
  forwardConsentPart: string;
  forwardNoticeSubject: string; // {title}
  forwardNoticeIntro: string; // {name} {title} {to}
  forwardNoticeNext: string; // {to}
  // a form without a signature (migration 169): nothing to sign, the person completes their details and submits
  invitationFormSubject: string; // {sender} {title}
  invitationFormIntro: string; // {name} {sender} {workspace} {title}
  invitationFormButton: string;
  reminderFormSubject: string; // {title}
  reminderFormIntro: string; // {name} {title}
  completedFormSubject: string; // {title}
  completedFormIntro: string; // {name} {title}
  completedFormAttached: string;
  declinedFormSubject: string; // {title}
  declinedFormIntro: string; // {name} {title}
  expiredFormIntro: string; // {title}
  forwardConsentTurnForm: string;
  footer: string; // {workspace}
}

const EN: Words = {
  invitationSubject: "{sender} asked you to sign: {title}",
  invitationFillSubject: "{sender} asked you to complete: {title}",
  invitationIntro: "Hello {name}, {sender} at {workspace} has sent you “{title}” to review and sign.",
  invitationIntroFill: "Hello {name}, {sender} at {workspace} has sent you “{title}” to complete.",
  invitationButton: "Review and sign",
  invitationButtonFill: "Open and complete",
  expires: "This link works until {date}.",
  codeNote: "You will be asked for a 6-digit code that we send to this email address.",
  messageFrom: "Message from {sender}:",
  notExpecting: "If you were not expecting this, do not use the link and tell {sender}.",
  linkIsPersonal: "The link is personal to you. Do not forward it.",
  reminderSubject: "Reminder: please sign {title}",
  reminderIntro: "Hello {name}, this is a reminder that “{title}” is waiting for you.",
  reminderNewLink: "Use this link: any earlier link for this document no longer works.",
  reminderPartsOne: "You still have 1 part to complete: {parts}.",
  reminderPartsMany: "You still have {count} parts to complete: {parts}.",
  codeSubject: "Your verification code",
  codeIntro: "Your code to open “{title}” is:",
  codeValid: "It works for 10 minutes.",
  codeIgnore: "If you did not ask for this code, ignore this message.",
  completedSubject: "Signed: {title}",
  completedIntro: "Hello {name}, “{title}” has been signed by everyone.",
  completedAttached: "The signed copy is attached to this message.",
  completedLink: "You can also download it here:",
  declinedSubject: "Declined: {title}",
  declinedIntro: "{name} declined to sign “{title}”.",
  declinedReason: "Reason given: {reason}",
  expiredSubject: "Expired: {title}",
  expiredIntro: "“{title}” expired before everyone signed. Nobody can sign it now; send it again if it is still needed.",
  voidedSubject: "Cancelled: {title}",
  voidedIntro: "“{title}” was cancelled by the sender. You do not need to do anything.",
  forwardSubject: "{forwarder} passed this on to you: {title}",
  forwardIntroTurn: "Hello {name}, {forwarder} has passed “{title}” on to you to complete in their place. It was sent by {sender} at {workspace}.",
  forwardIntroPart: "Hello {name}, {forwarder} has asked you to complete one part of “{title}”: {part}. It was sent by {sender} at {workspace}.",
  forwardConsentTurn: "You will be asked to agree to sign electronically yourself, then to review and sign.",
  forwardConsentPart: "You will only see that part. You do not sign anything.",
  forwardNoticeSubject: "Forwarded: {title}",
  forwardNoticeIntro: "{name} passed their turn on “{title}” on to {to}.",
  forwardNoticeNext: "{to} has been sent a link of their own. The earlier link no longer works.",
  invitationFormSubject: "Please complete your details: {title}",
  invitationFormIntro: "Hello {name}, {sender} at {workspace} has asked you to complete your details in “{title}”. There is nothing to sign.",
  invitationFormButton: "Complete your details",
  reminderFormSubject: "Reminder: please complete your details: {title}",
  reminderFormIntro: "Hello {name}, this is a reminder that “{title}” is waiting for your details.",
  completedFormSubject: "Received: {title}",
  completedFormIntro: "Hello {name}, the details in “{title}” have been submitted. Thank you.",
  completedFormAttached: "A record of what was submitted is attached to this message.",
  declinedFormSubject: "Not completed: {title}",
  declinedFormIntro: "{name} declined to complete “{title}”.",
  expiredFormIntro: "“{title}” expired before everyone submitted their details. Nobody can complete it now; send it again if it is still needed.",
  forwardConsentTurnForm: "You will be asked to agree to submit electronically yourself, then to review and submit.",
  footer: "Sent through Halo Doc Sign for {workspace}.",
};

const MS: Words = {
  invitationSubject: "{sender} meminta anda menandatangani: {title}",
  invitationFillSubject: "{sender} meminta anda melengkapkan: {title}",
  invitationIntro: "Helo {name}, {sender} di {workspace} telah menghantar “{title}” untuk anda semak dan tandatangani.",
  invitationIntroFill: "Helo {name}, {sender} di {workspace} telah menghantar “{title}” untuk anda lengkapkan.",
  invitationButton: "Semak dan tandatangan",
  invitationButtonFill: "Buka dan lengkapkan",
  expires: "Pautan ini sah sehingga {date}.",
  codeNote: "Anda akan diminta memasukkan kod 6 digit yang kami hantar ke alamat e-mel ini.",
  messageFrom: "Mesej daripada {sender}:",
  notExpecting: "Jika anda tidak menjangkakan ini, jangan guna pautan dan maklumkan kepada {sender}.",
  linkIsPersonal: "Pautan ini khusus untuk anda. Jangan majukan.",
  reminderSubject: "Peringatan: sila tandatangani {title}",
  reminderIntro: "Helo {name}, ini peringatan bahawa “{title}” sedang menunggu anda.",
  reminderNewLink: "Gunakan pautan ini: pautan terdahulu untuk dokumen ini tidak lagi berfungsi.",
  reminderPartsOne: "Anda masih ada 1 bahagian untuk dilengkapkan: {parts}.",
  reminderPartsMany: "Anda masih ada {count} bahagian untuk dilengkapkan: {parts}.",
  codeSubject: "Kod pengesahan anda",
  codeIntro: "Kod anda untuk membuka “{title}” ialah:",
  codeValid: "Kod ini sah selama 10 minit.",
  codeIgnore: "Jika anda tidak meminta kod ini, abaikan mesej ini.",
  completedSubject: "Telah ditandatangani: {title}",
  completedIntro: "Helo {name}, “{title}” telah ditandatangani oleh semua pihak.",
  completedAttached: "Salinan yang ditandatangani dilampirkan pada mesej ini.",
  completedLink: "Anda juga boleh memuat turunnya di sini:",
  declinedSubject: "Ditolak: {title}",
  declinedIntro: "{name} enggan menandatangani “{title}”.",
  declinedReason: "Sebab yang diberikan: {reason}",
  expiredSubject: "Tamat tempoh: {title}",
  expiredIntro: "“{title}” tamat tempoh sebelum semua pihak menandatangani. Tiada siapa boleh menandatanganinya sekarang; hantar semula jika masih diperlukan.",
  voidedSubject: "Dibatalkan: {title}",
  voidedIntro: "“{title}” telah dibatalkan oleh penghantar. Anda tidak perlu berbuat apa-apa.",
  forwardSubject: "{forwarder} telah menyerahkan ini kepada anda: {title}",
  forwardIntroTurn: "Helo {name}, {forwarder} telah menyerahkan “{title}” kepada anda untuk dilengkapkan bagi pihaknya. Dokumen ini dihantar oleh {sender} di {workspace}.",
  forwardIntroPart: "Helo {name}, {forwarder} meminta anda melengkapkan satu bahagian “{title}”: {part}. Dokumen ini dihantar oleh {sender} di {workspace}.",
  forwardConsentTurn: "Anda akan diminta bersetuju menandatangani secara elektronik sendiri, kemudian menyemak dan menandatangani.",
  forwardConsentPart: "Anda hanya akan melihat bahagian itu. Anda tidak menandatangani apa-apa.",
  forwardNoticeSubject: "Diserahkan: {title}",
  forwardNoticeIntro: "{name} menyerahkan gilirannya untuk “{title}” kepada {to}.",
  forwardNoticeNext: "{to} telah dihantar pautan tersendiri. Pautan terdahulu tidak lagi berfungsi.",
  invitationFormSubject: "Sila lengkapkan butiran anda: {title}",
  invitationFormIntro: "Helo {name}, {sender} di {workspace} meminta anda melengkapkan butiran anda dalam “{title}”. Tiada apa-apa untuk ditandatangani.",
  invitationFormButton: "Lengkapkan butiran anda",
  reminderFormSubject: "Peringatan: sila lengkapkan butiran anda: {title}",
  reminderFormIntro: "Helo {name}, ini peringatan bahawa “{title}” sedang menunggu butiran anda.",
  completedFormSubject: "Diterima: {title}",
  completedFormIntro: "Helo {name}, butiran dalam “{title}” telah dihantar. Terima kasih.",
  completedFormAttached: "Rekod apa yang dihantar dilampirkan pada mesej ini.",
  declinedFormSubject: "Tidak dilengkapkan: {title}",
  declinedFormIntro: "{name} enggan melengkapkan “{title}”.",
  expiredFormIntro: "“{title}” tamat tempoh sebelum semua pihak menghantar butiran mereka. Tiada siapa boleh melengkapkannya sekarang; hantar semula jika masih diperlukan.",
  forwardConsentTurnForm: "Anda akan diminta bersetuju menghantar secara elektronik sendiri, kemudian menyemak dan menghantar.",
  footer: "Dihantar melalui Halo Doc Sign untuk {workspace}.",
};

const ZH: Words = {
  invitationSubject: "{sender} 请您签署：{title}",
  invitationFillSubject: "{sender} 请您填写：{title}",
  invitationIntro: "{name}，您好。{workspace} 的 {sender} 向您发送了《{title}》，请查阅并签署。",
  invitationIntroFill: "{name}，您好。{workspace} 的 {sender} 向您发送了《{title}》，请填写。",
  invitationButton: "查阅并签署",
  invitationButtonFill: "打开并填写",
  expires: "此链接有效期至 {date}。",
  codeNote: "系统会要求您输入我们发送到此邮箱的 6 位验证码。",
  messageFrom: "来自 {sender} 的留言：",
  notExpecting: "如果您没有预期收到此邮件，请勿使用该链接，并告知 {sender}。",
  linkIsPersonal: "此链接仅供您本人使用，请勿转发。",
  reminderSubject: "提醒：请签署 {title}",
  reminderIntro: "{name}，您好。《{title}》仍在等待您处理。",
  reminderNewLink: "请使用此链接：此文档之前的链接已失效。",
  reminderPartsOne: "您还有 1 个部分需要填写：{parts}。",
  reminderPartsMany: "您还有 {count} 个部分需要填写：{parts}。",
  codeSubject: "您的验证码",
  codeIntro: "打开《{title}》的验证码是：",
  codeValid: "验证码 10 分钟内有效。",
  codeIgnore: "如果这不是您本人的操作，请忽略此邮件。",
  completedSubject: "已签署：{title}",
  completedIntro: "{name}，您好。《{title}》已由所有人签署完成。",
  completedAttached: "已签署的副本见本邮件附件。",
  completedLink: "您也可以在此下载：",
  declinedSubject: "已拒绝：{title}",
  declinedIntro: "{name} 拒绝签署《{title}》。",
  declinedReason: "所述理由：{reason}",
  expiredSubject: "已过期：{title}",
  expiredIntro: "《{title}》在所有人签署之前已过期，现在无法再签署；如仍需要，请重新发送。",
  voidedSubject: "已取消：{title}",
  voidedIntro: "《{title}》已被发件人取消，您无需进行任何操作。",
  forwardSubject: "{forwarder} 把此文件转交给您：{title}",
  forwardIntroTurn: "{name}，您好。{forwarder} 已把《{title}》转交给您，请您代其完成。该文件由 {workspace} 的 {sender} 发送。",
  forwardIntroPart: "{name}，您好。{forwarder} 请您填写《{title}》中的一个部分：{part}。该文件由 {workspace} 的 {sender} 发送。",
  forwardConsentTurn: "系统会请您自行同意以电子方式签署，然后查阅并签署。",
  forwardConsentPart: "您只会看到该部分，无需签署任何内容。",
  forwardNoticeSubject: "已转交：{title}",
  forwardNoticeIntro: "{name} 已把《{title}》中自己的环节转交给 {to}。",
  forwardNoticeNext: "{to} 已收到专属链接，之前的链接已失效。",
  invitationFormSubject: "请填写您的资料：{title}",
  invitationFormIntro: "{name}，您好。{workspace} 的 {sender} 请您填写《{title}》中的资料，无需签署任何内容。",
  invitationFormButton: "填写您的资料",
  reminderFormSubject: "提醒：请填写您的资料：{title}",
  reminderFormIntro: "{name}，您好。《{title}》仍在等待您填写资料。",
  completedFormSubject: "已收到：{title}",
  completedFormIntro: "{name}，您好。《{title}》中的资料已提交，谢谢。",
  completedFormAttached: "所提交内容的记录见本邮件附件。",
  declinedFormSubject: "未完成：{title}",
  declinedFormIntro: "{name} 拒绝填写《{title}》。",
  expiredFormIntro: "《{title}》在所有人提交资料之前已过期，现在无法再填写；如仍需要，请重新发送。",
  forwardConsentTurnForm: "系统会请您自行同意以电子方式提交，然后查阅并提交。",
  footer: "由 Halo Doc Sign 代表 {workspace} 发送。",
};

const KO: Words = {
  invitationSubject: "{sender}님이 서명을 요청했습니다: {title}",
  invitationFillSubject: "{sender}님이 작성을 요청했습니다: {title}",
  invitationIntro: "{name}님, 안녕하세요. {workspace}의 {sender}님이 “{title}”을(를) 검토하고 서명하도록 보냈습니다.",
  invitationIntroFill: "{name}님, 안녕하세요. {workspace}의 {sender}님이 “{title}”을(를) 작성하도록 보냈습니다.",
  invitationButton: "검토 후 서명",
  invitationButtonFill: "열어서 작성",
  expires: "이 링크는 {date}까지 사용할 수 있습니다.",
  codeNote: "이 이메일 주소로 보내드리는 6자리 코드를 입력하셔야 합니다.",
  messageFrom: "{sender}님의 메시지:",
  notExpecting: "예상하지 못한 메일이라면 링크를 사용하지 말고 {sender}님에게 알려 주세요.",
  linkIsPersonal: "이 링크는 본인 전용입니다. 전달하지 마세요.",
  reminderSubject: "알림: {title}에 서명해 주세요",
  reminderIntro: "{name}님, “{title}”이(가) 기다리고 있습니다.",
  reminderNewLink: "이 링크를 사용하세요. 이 문서의 이전 링크는 더 이상 작동하지 않습니다.",
  reminderPartsOne: "작성해야 할 부분이 1개 남아 있습니다: {parts}",
  reminderPartsMany: "작성해야 할 부분이 {count}개 남아 있습니다: {parts}",
  codeSubject: "인증 코드",
  codeIntro: "“{title}”을(를) 열기 위한 코드:",
  codeValid: "10분 동안 유효합니다.",
  codeIgnore: "요청하지 않았다면 이 메시지를 무시하세요.",
  completedSubject: "서명 완료: {title}",
  completedIntro: "{name}님, “{title}”에 모든 분의 서명이 완료되었습니다.",
  completedAttached: "서명본이 이 메일에 첨부되어 있습니다.",
  completedLink: "여기에서도 내려받을 수 있습니다:",
  declinedSubject: "거부됨: {title}",
  declinedIntro: "{name}님이 “{title}” 서명을 거부했습니다.",
  declinedReason: "사유: {reason}",
  expiredSubject: "만료됨: {title}",
  expiredIntro: "“{title}”이(가) 모두 서명하기 전에 만료되었습니다. 더 이상 서명할 수 없으며, 필요하면 다시 보내 주세요.",
  voidedSubject: "취소됨: {title}",
  voidedIntro: "“{title}”이(가) 발신자에 의해 취소되었습니다. 별도로 하실 일은 없습니다.",
  forwardSubject: "{forwarder}님이 이 문서를 전달했습니다: {title}",
  forwardIntroTurn: "{name}님, 안녕하세요. {forwarder}님이 “{title}”을(를) 대신 작성해 달라고 전달했습니다. 이 문서는 {workspace}의 {sender}님이 보냈습니다.",
  forwardIntroPart: "{name}님, 안녕하세요. {forwarder}님이 “{title}”의 한 부분을 작성해 달라고 요청했습니다: {part}. 이 문서는 {workspace}의 {sender}님이 보냈습니다.",
  forwardConsentTurn: "전자 서명에 직접 동의한 다음, 검토 후 서명하게 됩니다.",
  forwardConsentPart: "해당 부분만 볼 수 있으며, 서명할 것은 없습니다.",
  forwardNoticeSubject: "전달됨: {title}",
  forwardNoticeIntro: "{name}님이 “{title}”의 자기 차례를 {to}님에게 넘겼습니다.",
  forwardNoticeNext: "{to}님에게 전용 링크를 보냈으며, 이전 링크는 더 이상 작동하지 않습니다.",
  invitationFormSubject: "정보를 입력해 주세요: {title}",
  invitationFormIntro: "{name}님, 안녕하세요. {workspace}의 {sender}님이 “{title}”에 정보를 입력해 달라고 요청했습니다. 서명할 것은 없습니다.",
  invitationFormButton: "정보 입력하기",
  reminderFormSubject: "알림: 정보를 입력해 주세요: {title}",
  reminderFormIntro: "{name}님, “{title}”이(가) 정보 입력을 기다리고 있습니다.",
  completedFormSubject: "접수됨: {title}",
  completedFormIntro: "{name}님, “{title}”의 정보가 제출되었습니다. 감사합니다.",
  completedFormAttached: "제출된 내용의 기록이 이 메일에 첨부되어 있습니다.",
  declinedFormSubject: "작성하지 않음: {title}",
  declinedFormIntro: "{name}님이 “{title}” 작성을 거부했습니다.",
  expiredFormIntro: "“{title}”이(가) 모두 제출하기 전에 만료되었습니다. 더 이상 작성할 수 없으며, 필요하면 다시 보내 주세요.",
  forwardConsentTurnForm: "전자 제출에 직접 동의한 다음, 검토 후 제출하게 됩니다.",
  footer: "{workspace}을(를) 대신하여 Halo Doc Sign으로 발송되었습니다.",
};

const DICT: Record<SignLocale, Words> = { en: EN, ms: MS, zh: ZH, ko: KO };

export function wordsFor(locale: SignLocale): Words {
  return DICT[locale] ?? EN;
}

/**
 * Fill `{name}` style placeholders. Unknown placeholders are left alone. Values are put on one line,
 * so a name or title with a line break can never add a header to a subject.
 */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]).replace(/[\r\n\u2028\u2029]+/g, " ").trim() : m));
}

export interface Rendered {
  subject: string;
  html: string;
  text: string;
}

/** The date as the message reader sees it: 6 Oct 2026. */
export function longDate(d: Date, locale: SignLocale, timeZone = "UTC"): string {
  const tag = locale === "zh" ? "zh-CN" : locale === "ko" ? "ko-KR" : locale === "ms" ? "ms-MY" : "en-GB";
  try {
    return new Intl.DateTimeFormat(tag, { day: "numeric", month: "short", year: "numeric", timeZone }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

export function frame(inner: string, w: Words, workspace: string): string {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Noto Sans', sans-serif; max-width: 520px; margin: 0 auto; color: #1a1a1a;">
      ${inner}
      <p style="font-size: 12px; color: #8a8a99; line-height: 1.5; margin-top: 28px;">${escapeHtml(fill(w.footer, { workspace }))}</p>
    </div>`.trim();
}

export const button = (label: string, url: string) =>
  `<p style="margin: 24px 0;"><a href="${escapeHtml(url)}" style="display: inline-block; background: #4f46e5; color: #ffffff; text-decoration: none; padding: 11px 22px; border-radius: 7px; font-size: 15px; font-weight: 600;">${escapeHtml(label)}</a></p>`;

export const para = (text: string, style = "font-size: 15px; line-height: 1.55;") => `<p style="${style}">${escapeHtml(text)}</p>`;
export const small = (text: string) => para(text, "font-size: 13px; color: #666; line-height: 1.5;");

export interface InvitationArgs {
  locale: SignLocale;
  workspace: string;
  sender: string;
  signerName: string;
  title: string;
  /** The sender's own words, shown quoted. */
  message?: string | null;
  link: string;
  expiresAt?: Date | null;
  codeRequired: boolean;
  /** A filler completes fields and does not sign. */
  fill?: boolean;
  /** A form without a signature: the words say "complete your details", never "sign". */
  mode?: SignMode;
  timeZone?: string;
}

export function invitationEmail(a: InvitationArgs): Rendered {
  const w = wordsFor(a.locale);
  const v = { name: a.signerName, sender: a.sender, workspace: a.workspace, title: a.title };
  const formOnly = a.mode === "form";
  const subject = fill(formOnly ? w.invitationFormSubject : a.fill ? w.invitationFillSubject : w.invitationSubject, v);
  const intro = fill(formOnly ? w.invitationFormIntro : a.fill ? w.invitationIntroFill : w.invitationIntro, v);
  const expiry = a.expiresAt ? fill(w.expires, { date: longDate(a.expiresAt, a.locale, a.timeZone) }) : "";
  const label = formOnly ? w.invitationFormButton : a.fill ? w.invitationButtonFill : w.invitationButton;
  const lines = [intro];
  if (a.message?.trim()) lines.push("", fill(w.messageFrom, { sender: a.sender }), `“${a.message.trim()}”`);
  lines.push("", `${label}: ${a.link}`);
  if (expiry) lines.push("", expiry);
  if (a.codeRequired) lines.push(w.codeNote);
  lines.push("", w.linkIsPersonal, fill(w.notExpecting, { sender: a.sender }), "", fill(w.footer, { workspace: a.workspace }));
  const html = frame(
    [
      para(intro),
      a.message?.trim()
        ? `<div style="border-left: 3px solid #c7c3f5; padding: 2px 14px; margin: 16px 0; color: #444;"><p style="font-size: 12px; color: #777; margin: 0 0 4px;">${escapeHtml(fill(w.messageFrom, { sender: a.sender }))}</p><p style="font-size: 14px; line-height: 1.5; margin: 0; white-space: pre-wrap;">${escapeHtml(a.message.trim())}</p></div>`
        : "",
      button(label, a.link),
      expiry ? small(expiry) : "",
      a.codeRequired ? small(w.codeNote) : "",
      small(w.linkIsPersonal),
      small(fill(w.notExpecting, { sender: a.sender })),
      `<p style="font-size: 12px; color: #999; word-break: break-all;">${escapeHtml(a.link)}</p>`,
    ].join("\n"),
    w,
    a.workspace,
  );
  return { subject, html, text: lines.join("\n") };
}

export interface ForwardArgs extends Omit<InvitationArgs, "fill" | "message"> {
  /** The person who handed it over. */
  forwarder: string;
  /** What the forwarder wrote to the new person. */
  note?: string | null;
  /** Only one part of a form was handed over: its title, in the document's language. */
  part?: string | null;
}

/** The message to someone a turn, or a part of a form, was forwarded to. They get a link of their own and agree for themselves. */
export function forwardEmail(a: ForwardArgs): Rendered {
  const w = wordsFor(a.locale);
  const v = { name: a.signerName, forwarder: a.forwarder, sender: a.sender, workspace: a.workspace, title: a.title, part: a.part ?? "" };
  const subject = fill(w.forwardSubject, v);
  const intro = fill(a.part ? w.forwardIntroPart : w.forwardIntroTurn, v);
  const consent = a.part ? w.forwardConsentPart : a.mode === "form" ? w.forwardConsentTurnForm : w.forwardConsentTurn;
  const expiry = a.expiresAt ? fill(w.expires, { date: longDate(a.expiresAt, a.locale, a.timeZone) }) : "";
  const label = a.mode === "form" ? w.invitationFormButton : a.part ? w.invitationButtonFill : w.invitationButton;
  const note = a.note?.trim() ?? "";
  const lines = [intro, consent];
  if (note) lines.push("", fill(w.messageFrom, { sender: a.forwarder }), `“${note}”`);
  lines.push("", `${label}: ${a.link}`);
  if (expiry) lines.push("", expiry);
  if (a.codeRequired) lines.push(w.codeNote);
  lines.push("", w.linkIsPersonal, fill(w.notExpecting, { sender: a.sender }), "", fill(w.footer, { workspace: a.workspace }));
  const html = frame(
    [
      para(intro),
      para(consent),
      note
        ? `<div style="border-left: 3px solid #c7c3f5; padding: 2px 14px; margin: 16px 0; color: #444;"><p style="font-size: 12px; color: #777; margin: 0 0 4px;">${escapeHtml(fill(w.messageFrom, { sender: a.forwarder }))}</p><p style="font-size: 14px; line-height: 1.5; margin: 0; white-space: pre-wrap;">${escapeHtml(note)}</p></div>`
        : "",
      button(label, a.link),
      expiry ? small(expiry) : "",
      a.codeRequired ? small(w.codeNote) : "",
      small(w.linkIsPersonal),
      small(fill(w.notExpecting, { sender: a.sender })),
      `<p style="font-size: 12px; color: #999; word-break: break-all;">${escapeHtml(a.link)}</p>`,
    ].join("\n"),
    w,
    a.workspace,
  );
  return { subject, html, text: lines.join("\n") };
}

/** The sender is told a signer passed their turn on (the audit trail and Halo's own notification say the same). */
export function forwardNoticeEmail(a: { locale: SignLocale; workspace: string; title: string; name: string; to: string }): Rendered {
  const w = wordsFor(a.locale);
  const v = { name: a.name, title: a.title, to: a.to };
  const intro = fill(w.forwardNoticeIntro, v);
  const next = fill(w.forwardNoticeNext, v);
  return { subject: fill(w.forwardNoticeSubject, v), html: frame([para(intro), para(next)].join("\n"), w, a.workspace), text: [intro, next, "", fill(w.footer, { workspace: a.workspace })].join("\n") };
}

/** Part titles as one phrase: Chinese uses its own list comma. */
const joinParts = (parts: readonly string[], locale: SignLocale) => parts.join(locale === "zh" ? "、" : ", ");

/**
 * A reminder. For a document with a form, `partsLeft` names the parts the person has not finished (by title, in
 * the document's language), so the reminder says what is left rather than only that something is.
 */
export function reminderEmail(a: Omit<InvitationArgs, "message" | "fill"> & { partsLeft?: string[] }): Rendered {
  const w = wordsFor(a.locale);
  const v = { name: a.signerName, sender: a.sender, workspace: a.workspace, title: a.title };
  const formOnly = a.mode === "form";
  const intro = fill(formOnly ? w.reminderFormIntro : w.reminderIntro, v);
  const label = formOnly ? w.invitationFormButton : w.invitationButton;
  const parts = (a.partsLeft ?? []).map((p) => p.trim()).filter(Boolean);
  const left = parts.length === 0 ? "" : fill(parts.length === 1 ? w.reminderPartsOne : w.reminderPartsMany, { count: String(parts.length), parts: joinParts(parts, a.locale) });
  const expiry = a.expiresAt ? fill(w.expires, { date: longDate(a.expiresAt, a.locale, a.timeZone) }) : "";
  const text = [intro, ...(left ? [left] : []), "", `${label}: ${a.link}`, w.reminderNewLink, ...(expiry ? ["", expiry] : []), "", fill(w.footer, { workspace: a.workspace })].join("\n");
  const html = frame([para(intro), left ? para(left) : "", button(label, a.link), small(w.reminderNewLink), expiry ? small(expiry) : "", `<p style="font-size: 12px; color: #999; word-break: break-all;">${escapeHtml(a.link)}</p>`].join("\n"), w, a.workspace);
  return { subject: fill(formOnly ? w.reminderFormSubject : w.reminderSubject, v), html, text };
}

export function codeEmail(a: { locale: SignLocale; workspace: string; title: string; code: string }): Rendered {
  const w = wordsFor(a.locale);
  const intro = fill(w.codeIntro, { title: a.title });
  const text = [intro, "", a.code, "", w.codeValid, w.codeIgnore].join("\n");
  const html = frame(
    [para(intro), `<p style="font-size: 30px; letter-spacing: 6px; font-weight: 700; margin: 18px 0;">${escapeHtml(a.code)}</p>`, small(w.codeValid), small(w.codeIgnore)].join("\n"),
    w,
    a.workspace,
  );
  return { subject: w.codeSubject, html, text };
}

export function completedEmail(a: { locale: SignLocale; workspace: string; name: string; title: string; downloadUrl?: string; attached: boolean; mode?: SignMode }): Rendered {
  const w = wordsFor(a.locale);
  const v = { name: a.name, title: a.title };
  const formOnly = a.mode === "form";
  const intro = fill(formOnly ? w.completedFormIntro : w.completedIntro, v);
  const attachedNote = formOnly ? w.completedFormAttached : w.completedAttached;
  const lines = [intro];
  if (a.attached) lines.push(attachedNote);
  if (a.downloadUrl) lines.push(w.completedLink, a.downloadUrl);
  lines.push("", fill(w.footer, { workspace: a.workspace }));
  const html = frame(
    [para(intro), a.attached ? para(attachedNote) : "", a.downloadUrl ? `${small(w.completedLink)}${button(a.title, a.downloadUrl)}` : ""].join("\n"),
    w,
    a.workspace,
  );
  return { subject: fill(formOnly ? w.completedFormSubject : w.completedSubject, v), html, text: lines.join("\n") };
}

export function declinedEmail(a: { locale: SignLocale; workspace: string; name: string; title: string; reason?: string | null; mode?: SignMode }): Rendered {
  const w = wordsFor(a.locale);
  const v = { name: a.name, title: a.title };
  const formOnly = a.mode === "form";
  const intro = fill(formOnly ? w.declinedFormIntro : w.declinedIntro, v);
  const reason = a.reason?.trim() ? fill(w.declinedReason, { reason: a.reason.trim() }) : "";
  const text = [intro, ...(reason ? [reason] : []), "", fill(w.footer, { workspace: a.workspace })].join("\n");
  return { subject: fill(formOnly ? w.declinedFormSubject : w.declinedSubject, v), html: frame([para(intro), reason ? para(reason) : ""].join("\n"), w, a.workspace), text };
}

export function expiredEmail(a: { locale: SignLocale; workspace: string; title: string; mode?: SignMode }): Rendered {
  const w = wordsFor(a.locale);
  const intro = fill(a.mode === "form" ? w.expiredFormIntro : w.expiredIntro, { title: a.title });
  return { subject: fill(w.expiredSubject, { title: a.title }), html: frame(para(intro), w, a.workspace), text: [intro, "", fill(w.footer, { workspace: a.workspace })].join("\n") };
}

export function voidedEmail(a: { locale: SignLocale; workspace: string; title: string }): Rendered {
  const w = wordsFor(a.locale);
  const intro = fill(w.voidedIntro, { title: a.title });
  return { subject: fill(w.voidedSubject, { title: a.title }), html: frame(para(intro), w, a.workspace), text: [intro, "", fill(w.footer, { workspace: a.workspace })].join("\n") };
}
