// ============================================================
// Compliance requests, the words of the emails (Part B). The customer is outside the workspace and reads these in the language of their request (the
// language they chose on the form, else their contact's, else English), so the words are written here, not in Halo's own message files (the same rule as
// Secure Sign's messages.ts, whose HTML helpers and `fill` they use). Pure: each function returns a subject, an HTML body and a plain-text body.
//
// What a message NEVER carries, whoever reads it: bank details of any kind, the customer's phone number, a link to a screen of the workspace's staff, a
// file, or the regulatory hard stop. A customer email says what the request is, its reference, what happens next, and (when the staff wrote one) the
// words the staff chose to tell the customer: a reason for a rejection, a question. The 14 days is the practice target the workspace aims for; it is the
// only date a customer is ever told.
//
// [NATIVE REVIEW] The Malay, Chinese and Korean wording below was written for this build and has not been read by a native speaker of each language.
// ============================================================

import { escapeHtml, fill, para, small, type Rendered } from "@/lib/sign/messages";

import type { CustomerLocale } from "./types";

export type { Rendered };

export const CUSTOMER_LOCALES: readonly CustomerLocale[] = ["en", "ms", "zh", "ko"];

/** A language code from anywhere (a form, a contact's "ms-MY", "zh_CN", "english") as one of the four, or null. */
export function customerLocaleOf(value: string | null | undefined): CustomerLocale | null {
  if (!value) return null;
  const base = value.trim().toLowerCase().split(/[-_]/)[0];
  return (CUSTOMER_LOCALES as readonly string[]).includes(base) ? (base as CustomerLocale) : null;
}

interface Words {
  hello: string; // {name}
  footer: string; // {workspace}
  receivedSubject: string; // {reference}
  receivedClosure: string; // {reference}
  receivedWithdrawal: string; // {reference}
  receivedOther: string; // {reference}
  nextTitle: string;
  next1: string;
  next2Target: string; // {days}
  next2: string;
  next3: string;
  keepReference: string;
  moreInfoSubject: string; // {reference}
  moreInfoIntro: string; // {reference}
  moreInfoHow: string;
  approvedSubject: string; // {reference}
  approvedBody: string; // {reference}
  rejectedSubject: string; // {reference}
  rejectedIntro: string; // {reference}
  rejectedReason: string;
  rejectedHow: string;
  completedSubject: string; // {reference}
  completedClosure: string; // {reference}
  completedWithdrawal: string; // {reference}
  completedPhone: string; // {reference}
  completedOther: string; // {reference}
  completedNote: string;
  // staff
  signoffSubject: string; // {reference}
  signoffBody: string; // {type} {reference} {recommendation}
  recApprove: string;
  recReject: string;
  recMoreInfo: string;
  alertSubjectDays: string; // {reference} {days}
  alertSubjectReached: string; // {reference}
  alertBodyDays: string; // {type} {reference} {days}
  alertBodyReached: string; // {type} {reference}
  openIt: string;
  staffFooter: string; // {workspace}
  dayOne: string;
  dayMany: string;
  codeSubject: string; // {code}
  codeIntro: string; // {workspace}
  codeValid: string; // {minutes}
  codeIgnore: string;
}

const EN: Words = {
  hello: "Hello {name},",
  footer: "Sent on behalf of {workspace}.",
  receivedSubject: "We have received your request {reference}",
  receivedClosure: "We have received your request to close your Vircle E-Wallet account. Your reference is {reference}.",
  receivedWithdrawal: "We have received your request to withdraw funds from your Vircle E-Wallet account. Your reference is {reference}.",
  receivedOther: "We have received your request. Your reference is {reference}.",
  nextTitle: "What happens next",
  next1: "We check that the request really comes from you. A member of our team may contact you.",
  next2Target: "We review your request. We aim to complete closure within {days} days of your request.",
  next2: "We review your request.",
  next3: "We email you when it is done, or if we need anything more from you.",
  keepReference: "Please keep your reference. If you did not make this request, reply to this email or contact Customer Support straight away.",
  moreInfoSubject: "We need a little more information ({reference})",
  moreInfoIntro: "We are looking at your request {reference} and need a little more from you:",
  moreInfoHow: "Please reply to this email with what we asked for, or contact Customer Support and quote your reference.",
  approvedSubject: "Your request {reference} has been approved",
  approvedBody: "Your request {reference} has been approved and our team is now carrying it out. We will email you again when it is done.",
  rejectedSubject: "About your request {reference}",
  rejectedIntro: "We are sorry, we are not able to go ahead with your request {reference}.",
  rejectedReason: "The reason:",
  rejectedHow: "If you think this is a mistake, or you can give us what is missing, reply to this email or contact Customer Support and quote your reference.",
  completedSubject: "Your request {reference} is complete",
  completedClosure: "Your request {reference} is complete. Your Vircle E-Wallet account has been closed and the balance has been sent to the bank account you gave us.",
  completedWithdrawal: "Your request {reference} is complete. The amount you asked for has been sent to the bank account you gave us.",
  completedPhone: "Your request {reference} is complete. The phone number on your account has been changed.",
  completedOther: "Your request {reference} is complete.",
  completedNote: "A transfer can take a little time to show in your bank.",
  signoffSubject: "{reference} is waiting for your sign-off",
  signoffBody: "{type} request {reference} has been reviewed and is waiting for sign-off. The officer recommends that you {recommendation}.",
  recApprove: "approve it",
  recReject: "reject it",
  recMoreInfo: "ask the customer for more information",
  alertSubjectDays: "{reference}: {days} to the hard stop date",
  alertSubjectReached: "{reference}: the hard stop date has been reached",
  alertBodyDays: "{type} request {reference} is {days} from its hard stop date and is not finished.",
  alertBodyReached: "{type} request {reference} has reached its hard stop date and is not finished.",
  openIt: "Open Compliance in Halo to see it.",
  staffFooter: "Sent by Halo for {workspace}.",
  dayOne: "{n} day",
  dayMany: "{n} days",
  codeSubject: "Your confirmation code: {code}",
  codeIntro: "Your confirmation code for {workspace} is:",
  codeValid: "The code is valid for {minutes} minutes.",
  codeIgnore: "If you did not ask for this code, you can ignore this email. Nothing has been requested.",
};

const MS: Words = {
  hello: "Salam {name},",
  footer: "Dihantar bagi pihak {workspace}.",
  receivedSubject: "Kami telah menerima permintaan anda {reference}",
  receivedClosure: "Kami telah menerima permintaan anda untuk menutup akaun E-Wallet Vircle anda. Rujukan anda ialah {reference}.",
  receivedWithdrawal: "Kami telah menerima permintaan anda untuk mengeluarkan dana daripada akaun E-Wallet Vircle anda. Rujukan anda ialah {reference}.",
  receivedOther: "Kami telah menerima permintaan anda. Rujukan anda ialah {reference}.",
  nextTitle: "Apa yang berlaku seterusnya",
  next1: "Kami menyemak bahawa permintaan ini benar-benar datang daripada anda. Seorang ahli pasukan kami mungkin akan menghubungi anda.",
  next2Target: "Kami menyemak permintaan anda. Kami berusaha menyiapkan penutupan akaun dalam tempoh {days} hari daripada tarikh permintaan anda.",
  next2: "Kami menyemak permintaan anda.",
  next3: "Kami akan menghantar e-mel kepada anda apabila ia selesai, atau jika kami memerlukan maklumat tambahan daripada anda.",
  keepReference: "Sila simpan rujukan anda. Jika anda tidak membuat permintaan ini, balas e-mel ini atau hubungi Sokongan Pelanggan dengan segera.",
  moreInfoSubject: "Kami memerlukan sedikit maklumat tambahan ({reference})",
  moreInfoIntro: "Kami sedang menyemak permintaan anda {reference} dan memerlukan sedikit maklumat tambahan daripada anda:",
  moreInfoHow: "Sila balas e-mel ini dengan apa yang kami minta, atau hubungi Sokongan Pelanggan dan nyatakan rujukan anda.",
  approvedSubject: "Permintaan anda {reference} telah diluluskan",
  approvedBody: "Permintaan anda {reference} telah diluluskan dan pasukan kami sedang melaksanakannya. Kami akan menghantar e-mel lagi apabila ia selesai.",
  rejectedSubject: "Mengenai permintaan anda {reference}",
  rejectedIntro: "Kami memohon maaf, kami tidak dapat meneruskan permintaan anda {reference}.",
  rejectedReason: "Sebabnya:",
  rejectedHow: "Jika anda rasa ini satu kesilapan, atau anda boleh memberikan apa yang kurang, balas e-mel ini atau hubungi Sokongan Pelanggan dan nyatakan rujukan anda.",
  completedSubject: "Permintaan anda {reference} telah selesai",
  completedClosure: "Permintaan anda {reference} telah selesai. Akaun E-Wallet Vircle anda telah ditutup dan baki telah dihantar ke akaun bank yang anda berikan.",
  completedWithdrawal: "Permintaan anda {reference} telah selesai. Jumlah yang anda minta telah dihantar ke akaun bank yang anda berikan.",
  completedPhone: "Permintaan anda {reference} telah selesai. Nombor telefon pada akaun anda telah ditukar.",
  completedOther: "Permintaan anda {reference} telah selesai.",
  completedNote: "Pemindahan mungkin mengambil sedikit masa untuk dipaparkan di bank anda.",
  signoffSubject: "{reference} menunggu kelulusan anda",
  signoffBody: "Permintaan {type} {reference} telah disemak dan menunggu kelulusan. Pegawai mengesyorkan agar anda {recommendation}.",
  recApprove: "meluluskannya",
  recReject: "menolaknya",
  recMoreInfo: "meminta maklumat tambahan daripada pelanggan",
  alertSubjectDays: "{reference}: {days} sebelum tarikh henti muktamad",
  alertSubjectReached: "{reference}: tarikh henti muktamad telah dicapai",
  alertBodyDays: "Permintaan {type} {reference} tinggal {days} sebelum tarikh henti muktamadnya dan belum selesai.",
  alertBodyReached: "Permintaan {type} {reference} telah mencapai tarikh henti muktamadnya dan belum selesai.",
  openIt: "Buka Pematuhan dalam Halo untuk melihatnya.",
  staffFooter: "Dihantar oleh Halo untuk {workspace}.",
  dayOne: "{n} hari",
  dayMany: "{n} hari",
  codeSubject: "Kod pengesahan anda: {code}",
  codeIntro: "Kod pengesahan anda untuk {workspace} ialah:",
  codeValid: "Kod ini sah selama {minutes} minit.",
  codeIgnore: "Jika anda tidak meminta kod ini, anda boleh mengabaikan e-mel ini. Tiada permintaan telah dibuat.",
};

const ZH: Words = {
  hello: "{name}，您好：",
  footer: "代表 {workspace} 发送。",
  receivedSubject: "我们已收到您的请求 {reference}",
  receivedClosure: "我们已收到您关闭 Vircle 电子钱包账户的请求。您的参考编号是 {reference}。",
  receivedWithdrawal: "我们已收到您从 Vircle 电子钱包账户提取资金的请求。您的参考编号是 {reference}。",
  receivedOther: "我们已收到您的请求。您的参考编号是 {reference}。",
  nextTitle: "接下来会怎样",
  next1: "我们会核实这个请求确实来自您本人，我们的工作人员可能会联系您。",
  next2Target: "我们会审核您的请求。我们力争在您提出请求后的 {days} 天内完成账户关闭。",
  next2: "我们会审核您的请求。",
  next3: "处理完成后，或需要您提供更多信息时，我们会发送电子邮件告知您。",
  keepReference: "请保留您的参考编号。如果这不是您本人提出的请求，请回复此邮件或立即联系客户支持。",
  moreInfoSubject: "我们需要您提供更多信息（{reference}）",
  moreInfoIntro: "我们正在处理您的请求 {reference}，需要您再提供一些信息：",
  moreInfoHow: "请回复此邮件并提供我们所需的信息，或联系客户支持并告知您的参考编号。",
  approvedSubject: "您的请求 {reference} 已获批准",
  approvedBody: "您的请求 {reference} 已获批准，我们的团队正在办理。办理完成后，我们会再次发送电子邮件告知您。",
  rejectedSubject: "关于您的请求 {reference}",
  rejectedIntro: "很抱歉，我们无法继续办理您的请求 {reference}。",
  rejectedReason: "原因：",
  rejectedHow: "如果您认为这是个误会，或者您可以补充所缺的内容，请回复此邮件或联系客户支持并告知您的参考编号。",
  completedSubject: "您的请求 {reference} 已完成",
  completedClosure: "您的请求 {reference} 已完成。您的 Vircle 电子钱包账户已关闭，余额已转入您提供的银行账户。",
  completedWithdrawal: "您的请求 {reference} 已完成。您申请的金额已转入您提供的银行账户。",
  completedPhone: "您的请求 {reference} 已完成。您账户上的手机号码已更改。",
  completedOther: "您的请求 {reference} 已完成。",
  completedNote: "转账可能需要一点时间才会显示在您的银行账户中。",
  signoffSubject: "{reference} 正等待您的签批",
  signoffBody: "{type}请求 {reference} 已审核完毕，正等待签批。经办人建议您{recommendation}。",
  recApprove: "批准",
  recReject: "拒绝",
  recMoreInfo: "请客户补充信息",
  alertSubjectDays: "{reference}：距最后期限还有{days}",
  alertSubjectReached: "{reference}：已到最后期限",
  alertBodyDays: "{type}请求 {reference} 距最后期限还有{days}，尚未完成。",
  alertBodyReached: "{type}请求 {reference} 已到最后期限，尚未完成。",
  openIt: "请在 Halo 中打开“合规”查看。",
  staffFooter: "由 Halo 代表 {workspace} 发送。",
  dayOne: "{n} 天",
  dayMany: "{n} 天",
  codeSubject: "您的验证码：{code}",
  codeIntro: "您在 {workspace} 的验证码是：",
  codeValid: "验证码在 {minutes} 分钟内有效。",
  codeIgnore: "如果您没有申请此验证码，请忽略这封邮件。没有提交任何请求。",
};

const KO: Words = {
  hello: "{name}님, 안녕하세요.",
  footer: "{workspace}을(를) 대신하여 발송되었습니다.",
  receivedSubject: "요청 {reference}을(를) 접수했습니다",
  receivedClosure: "Vircle E-Wallet 계정 해지 요청을 접수했습니다. 참조 번호는 {reference}입니다.",
  receivedWithdrawal: "Vircle E-Wallet 계정에서 자금을 인출하려는 요청을 접수했습니다. 참조 번호는 {reference}입니다.",
  receivedOther: "요청을 접수했습니다. 참조 번호는 {reference}입니다.",
  nextTitle: "앞으로의 진행 과정",
  next1: "요청이 본인에게서 온 것이 맞는지 확인합니다. 담당자가 연락드릴 수 있습니다.",
  next2Target: "요청을 검토합니다. 요청일로부터 {days}일 이내에 해지를 완료하는 것을 목표로 합니다.",
  next2: "요청을 검토합니다.",
  next3: "처리가 끝났을 때, 또는 추가로 필요한 것이 있을 때 이메일로 알려 드립니다.",
  keepReference: "참조 번호를 보관해 주세요. 본인이 한 요청이 아니라면 이 이메일에 회신하거나 고객 지원에 바로 연락해 주세요.",
  moreInfoSubject: "추가 정보가 필요합니다({reference})",
  moreInfoIntro: "요청 {reference}을(를) 검토 중이며 추가 정보가 조금 필요합니다.",
  moreInfoHow: "요청드린 내용을 이 이메일에 회신해 주시거나, 고객 지원에 참조 번호와 함께 연락해 주세요.",
  approvedSubject: "요청 {reference}이(가) 승인되었습니다",
  approvedBody: "요청 {reference}이(가) 승인되어 담당 팀이 처리하고 있습니다. 처리가 끝나면 다시 이메일로 알려 드립니다.",
  rejectedSubject: "요청 {reference}에 관하여",
  rejectedIntro: "죄송합니다. 요청 {reference}을(를) 진행할 수 없습니다.",
  rejectedReason: "사유:",
  rejectedHow: "잘못된 판단이라고 생각하시거나 부족한 내용을 제공해 주실 수 있다면, 이 이메일에 회신하거나 고객 지원에 참조 번호와 함께 연락해 주세요.",
  completedSubject: "요청 {reference}이(가) 완료되었습니다",
  completedClosure: "요청 {reference}이(가) 완료되었습니다. Vircle E-Wallet 계정이 해지되었고 잔액은 알려 주신 은행 계좌로 보내졌습니다.",
  completedWithdrawal: "요청 {reference}이(가) 완료되었습니다. 요청하신 금액이 알려 주신 은행 계좌로 보내졌습니다.",
  completedPhone: "요청 {reference}이(가) 완료되었습니다. 계정의 전화번호가 변경되었습니다.",
  completedOther: "요청 {reference}이(가) 완료되었습니다.",
  completedNote: "이체가 은행에 반영되기까지 시간이 조금 걸릴 수 있습니다.",
  signoffSubject: "{reference}이(가) 최종 승인을 기다리고 있습니다",
  signoffBody: "{type} 요청 {reference}의 검토가 끝나 최종 승인을 기다리고 있습니다. 담당자의 의견은 “{recommendation}”입니다.",
  recApprove: "승인",
  recReject: "거절",
  recMoreInfo: "고객에게 추가 정보 요청",
  alertSubjectDays: "{reference}: 최종 기한까지 {days}",
  alertSubjectReached: "{reference}: 최종 기한에 도달했습니다",
  alertBodyDays: "{type} 요청 {reference}의 최종 기한까지 {days} 남았으며 아직 완료되지 않았습니다.",
  alertBodyReached: "{type} 요청 {reference}이(가) 최종 기한에 도달했으며 아직 완료되지 않았습니다.",
  openIt: "Halo에서 컴플라이언스를 열어 확인하세요.",
  staffFooter: "{workspace}을(를) 위해 Halo에서 발송했습니다.",
  dayOne: "{n}일",
  dayMany: "{n}일",
  codeSubject: "확인 코드: {code}",
  codeIntro: "{workspace}의 확인 코드는 다음과 같습니다.",
  codeValid: "이 코드는 {minutes}분 동안 유효합니다.",
  codeIgnore: "이 코드를 요청하지 않으셨다면 이 이메일을 무시하셔도 됩니다. 접수된 요청은 없습니다.",
};

const DICT: Record<CustomerLocale, Words> = { en: EN, ms: MS, zh: ZH, ko: KO };
export const wordsOf = (locale: CustomerLocale): Words => DICT[locale] ?? EN;

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Noto Sans', sans-serif";

function frame(inner: string, footer: string): string {
  return `
    <div style="font-family: ${FONT}; max-width: 520px; margin: 0 auto; color: #1a1a1a;">
      ${inner}
      <p style="font-size: 12px; color: #8a8a99; line-height: 1.5; margin-top: 28px;">${escapeHtml(footer)}</p>
    </div>`.trim();
}

/** The person's own words, quoted on lines of their own: never part of a sentence of ours. */
const quote = (text: string) =>
  `<div style="border-left: 3px solid #c7c3f5; padding: 2px 14px; margin: 16px 0; color: #444;"><p style="font-size: 14px; line-height: 1.5; margin: 0; white-space: pre-wrap;">${escapeHtml(text)}</p></div>`;

const list = (items: string[]) => `<ol style="font-size: 15px; line-height: 1.55; padding-left: 20px;">${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ol>`;

export type CustomerNotice = "received" | "more_info" | "approved" | "rejected" | "completed";

export interface CustomerEmailArgs {
  locale: CustomerLocale;
  workspace: string;
  name: string;
  reference: string;
  /** closure, withdrawal, phone_change or a custom type's key: chooses the sentence. */
  typeKey: string;
  /** The practice target in days (closure): the only date a customer is told. Null: none is mentioned. */
  targetDays?: number | null;
  /** The staff's words: the question (more_info) or the reason (rejected). */
  text?: string | null;
}

/** First word of a name for the greeting is NOT used: the greeting uses the name as the customer typed it. */
const hello = (w: Words, name: string) => fill(w.hello, { name });

export function customerEmail(kind: CustomerNotice, a: CustomerEmailArgs): Rendered {
  const w = wordsOf(a.locale);
  const v = { reference: a.reference, name: a.name };
  const greeting = hello(w, a.name);
  const footer = fill(w.footer, { workspace: a.workspace });
  const text = (a.text ?? "").trim();
  switch (kind) {
    case "received": {
      const intro = fill(a.typeKey === "closure" ? w.receivedClosure : a.typeKey === "withdrawal" ? w.receivedWithdrawal : w.receivedOther, v);
      const target = a.typeKey === "closure" && a.targetDays && a.targetDays > 0 ? fill(w.next2Target, { days: String(a.targetDays) }) : w.next2;
      const steps = [w.next1, target, w.next3];
      return {
        subject: fill(w.receivedSubject, v),
        html: frame([para(greeting), para(intro), `<p style="font-size: 15px; font-weight: 600; margin-bottom: 0;">${escapeHtml(w.nextTitle)}</p>`, list(steps), small(w.keepReference)].join("\n"), footer),
        text: [greeting, "", intro, "", w.nextTitle, ...steps.map((s, i) => `${i + 1}. ${s}`), "", w.keepReference, "", footer].join("\n"),
      };
    }
    case "more_info": {
      const intro = fill(w.moreInfoIntro, v);
      return {
        subject: fill(w.moreInfoSubject, v),
        html: frame([para(greeting), para(intro), quote(text), small(w.moreInfoHow)].join("\n"), footer),
        text: [greeting, "", intro, "", text, "", w.moreInfoHow, "", footer].join("\n"),
      };
    }
    case "approved": {
      const body = fill(w.approvedBody, v);
      return { subject: fill(w.approvedSubject, v), html: frame([para(greeting), para(body)].join("\n"), footer), text: [greeting, "", body, "", footer].join("\n") };
    }
    case "rejected": {
      const intro = fill(w.rejectedIntro, v);
      return {
        subject: fill(w.rejectedSubject, v),
        html: frame([para(greeting), para(intro), para(w.rejectedReason, "font-size: 14px; margin-bottom: 0;"), quote(text), small(w.rejectedHow)].join("\n"), footer),
        text: [greeting, "", intro, "", w.rejectedReason, text, "", w.rejectedHow, "", footer].join("\n"),
      };
    }
    case "completed": {
      const body = fill(a.typeKey === "closure" ? w.completedClosure : a.typeKey === "withdrawal" ? w.completedWithdrawal : a.typeKey === "phone_change" ? w.completedPhone : w.completedOther, v);
      const money = a.typeKey === "closure" || a.typeKey === "withdrawal";
      return {
        subject: fill(w.completedSubject, v),
        html: frame([para(greeting), para(body), ...(money ? [small(w.completedNote)] : [])].join("\n"), footer),
        text: [greeting, "", body, ...(money ? ["", w.completedNote] : []), "", footer].join("\n"),
      };
    }
  }
}

// ---- staff ------------------------------------------------------------------------------------------------------------

export interface StaffEmailArgs {
  locale: CustomerLocale;
  workspace: string;
  reference: string;
  /** The request type as the recipient reads it (the type's name in their language). */
  typeLabel: string;
}

const daysText = (w: Words, n: number) => fill(n === 1 ? w.dayOne : w.dayMany, { n: String(n) });

export function signoffWaitingEmail(a: StaffEmailArgs & { recommendation: "approve" | "reject" | "more_info" | null }): Rendered {
  const w = wordsOf(a.locale);
  const rec = a.recommendation === "approve" ? w.recApprove : a.recommendation === "reject" ? w.recReject : w.recMoreInfo;
  const body = fill(w.signoffBody, { type: a.typeLabel, reference: a.reference, recommendation: rec });
  const footer = fill(w.staffFooter, { workspace: a.workspace });
  return { subject: fill(w.signoffSubject, { reference: a.reference }), html: frame([para(body), small(w.openIt)].join("\n"), footer), text: [body, w.openIt, "", footer].join("\n") };
}

/** `daysLeft` 0 or less: the hard stop date has been reached. */
export function clockAlertEmail(a: StaffEmailArgs & { daysLeft: number }): Rendered {
  const w = wordsOf(a.locale);
  const reached = a.daysLeft <= 0;
  const days = daysText(w, Math.max(0, Math.round(a.daysLeft)));
  const subject = reached ? fill(w.alertSubjectReached, { reference: a.reference }) : fill(w.alertSubjectDays, { reference: a.reference, days });
  const body = reached ? fill(w.alertBodyReached, { type: a.typeLabel, reference: a.reference }) : fill(w.alertBodyDays, { type: a.typeLabel, reference: a.reference, days });
  const footer = fill(w.staffFooter, { workspace: a.workspace });
  return { subject, html: frame([para(body), small(w.openIt)].join("\n"), footer), text: [body, w.openIt, "", footer].join("\n") };
}

/** The message that carries the six-digit code a parent enters on the public form. Nothing else: no reference, no link. */
export function codeEmail(a: { locale: CustomerLocale; workspace: string; code: string }): Rendered {
  const w = wordsOf(a.locale);
  const intro = fill(w.codeIntro, { workspace: a.workspace });
  const valid = fill(w.codeValid, { minutes: "15" });
  const footer = fill(w.footer, { workspace: a.workspace });
  const big = `<p style="font-size: 30px; font-weight: 700; letter-spacing: 6px; margin: 16px 0; font-family: monospace;">${escapeHtml(a.code)}</p>`;
  return {
    subject: fill(w.codeSubject, { code: a.code }),
    html: frame([para(intro), big, small(valid), small(w.codeIgnore)].join("\n"), footer),
    text: [intro, a.code, "", valid, w.codeIgnore, "", footer].join("\n"),
  };
}
