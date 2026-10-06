// ============================================================
// The words of the messages Doc Sign sends: invitations, reminders, codes and outcomes. Signers are
// outside the workspace and read these in the document's language (English, Bahasa Melayu, Chinese or
// Korean), so they are written here rather than in Halo's own message files. Pure: each function
// returns the subject, an HTML body and a plain-text body.
// ============================================================

import type { SignLocale } from "./types";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface Words {
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

function frame(inner: string, w: Words, workspace: string): string {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Noto Sans', sans-serif; max-width: 520px; margin: 0 auto; color: #1a1a1a;">
      ${inner}
      <p style="font-size: 12px; color: #8a8a99; line-height: 1.5; margin-top: 28px;">${escapeHtml(fill(w.footer, { workspace }))}</p>
    </div>`.trim();
}

const button = (label: string, url: string) =>
  `<p style="margin: 24px 0;"><a href="${escapeHtml(url)}" style="display: inline-block; background: #4f46e5; color: #ffffff; text-decoration: none; padding: 11px 22px; border-radius: 7px; font-size: 15px; font-weight: 600;">${escapeHtml(label)}</a></p>`;

const para = (text: string, style = "font-size: 15px; line-height: 1.55;") => `<p style="${style}">${escapeHtml(text)}</p>`;
const small = (text: string) => para(text, "font-size: 13px; color: #666; line-height: 1.5;");

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
  timeZone?: string;
}

export function invitationEmail(a: InvitationArgs): Rendered {
  const w = wordsFor(a.locale);
  const v = { name: a.signerName, sender: a.sender, workspace: a.workspace, title: a.title };
  const subject = fill(a.fill ? w.invitationFillSubject : w.invitationSubject, v);
  const intro = fill(a.fill ? w.invitationIntroFill : w.invitationIntro, v);
  const expiry = a.expiresAt ? fill(w.expires, { date: longDate(a.expiresAt, a.locale, a.timeZone) }) : "";
  const label = a.fill ? w.invitationButtonFill : w.invitationButton;
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

export function reminderEmail(a: Omit<InvitationArgs, "message" | "fill">): Rendered {
  const w = wordsFor(a.locale);
  const v = { name: a.signerName, sender: a.sender, workspace: a.workspace, title: a.title };
  const intro = fill(w.reminderIntro, v);
  const expiry = a.expiresAt ? fill(w.expires, { date: longDate(a.expiresAt, a.locale, a.timeZone) }) : "";
  const text = [intro, "", `${w.invitationButton}: ${a.link}`, w.reminderNewLink, ...(expiry ? ["", expiry] : []), "", fill(w.footer, { workspace: a.workspace })].join("\n");
  const html = frame([para(intro), button(w.invitationButton, a.link), small(w.reminderNewLink), expiry ? small(expiry) : "", `<p style="font-size: 12px; color: #999; word-break: break-all;">${escapeHtml(a.link)}</p>`].join("\n"), w, a.workspace);
  return { subject: fill(w.reminderSubject, v), html, text };
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

export function completedEmail(a: { locale: SignLocale; workspace: string; name: string; title: string; downloadUrl?: string; attached: boolean }): Rendered {
  const w = wordsFor(a.locale);
  const v = { name: a.name, title: a.title };
  const intro = fill(w.completedIntro, v);
  const lines = [intro];
  if (a.attached) lines.push(w.completedAttached);
  if (a.downloadUrl) lines.push(w.completedLink, a.downloadUrl);
  lines.push("", fill(w.footer, { workspace: a.workspace }));
  const html = frame(
    [para(intro), a.attached ? para(w.completedAttached) : "", a.downloadUrl ? `${small(w.completedLink)}${button(a.title, a.downloadUrl)}` : ""].join("\n"),
    w,
    a.workspace,
  );
  return { subject: fill(w.completedSubject, v), html, text: lines.join("\n") };
}

export function declinedEmail(a: { locale: SignLocale; workspace: string; name: string; title: string; reason?: string | null }): Rendered {
  const w = wordsFor(a.locale);
  const v = { name: a.name, title: a.title };
  const intro = fill(w.declinedIntro, v);
  const reason = a.reason?.trim() ? fill(w.declinedReason, { reason: a.reason.trim() }) : "";
  const text = [intro, ...(reason ? [reason] : []), "", fill(w.footer, { workspace: a.workspace })].join("\n");
  return { subject: fill(w.declinedSubject, v), html: frame([para(intro), reason ? para(reason) : ""].join("\n"), w, a.workspace), text };
}

export function expiredEmail(a: { locale: SignLocale; workspace: string; title: string }): Rendered {
  const w = wordsFor(a.locale);
  const intro = fill(w.expiredIntro, { title: a.title });
  return { subject: fill(w.expiredSubject, { title: a.title }), html: frame(para(intro), w, a.workspace), text: [intro, "", fill(w.footer, { workspace: a.workspace })].join("\n") };
}

export function voidedEmail(a: { locale: SignLocale; workspace: string; title: string }): Rendered {
  const w = wordsFor(a.locale);
  const intro = fill(w.voidedIntro, { title: a.title });
  return { subject: fill(w.voidedSubject, { title: a.title }), html: frame(para(intro), w, a.workspace), text: [intro, "", fill(w.footer, { workspace: a.workspace })].join("\n") };
}
