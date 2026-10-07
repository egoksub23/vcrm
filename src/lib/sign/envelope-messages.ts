// ============================================================
// The words of the messages an ENVELOPE sends (migration 171): one invitation, one reminder and one completion message for each person,
// whatever the number of documents. Signers are outside the workspace and read these in the envelope's language, so they are written here
// rather than in Halo's own message files (the same rule as messages.ts, whose frame and footer they share). Pure.
//
// A declined, expired or cancelled envelope uses the single-document messages with the envelope's title (they say "<title> was
// cancelled", which is true of the whole envelope).
// ============================================================

import { certificatesSentence } from "./certificate-mail-words";
import { button, escapeHtml, fill, frame, longDate, para, small, wordsFor, type Rendered } from "./messages";
import type { SignLocale, SignMode } from "./types";

interface EnvelopeWords {
  invitationSubject: string; // {sender} {count} {title}
  invitationSubjectFill: string;
  invitationIntro: string; // {name} {sender} {workspace} {count} {title}
  invitationIntroFill: string;
  oneLink: string;
  documentsHeading: string;
  reminderSubject: string; // {count} {title}
  reminderSubjectFill: string;
  reminderIntro: string; // {name} {count} {title}
  completedSubject: string; // {title} {count}
  completedIntro: string; // {name} {title} {count}
  completedAttached: string; // {count}
  completedSomeAttached: string; // {attached} {count}
  completedNoneAttached: string;
  completedFormSubject: string;
  completedFormIntro: string;
  completedFormAttached: string; // {count}
}

const EN: EnvelopeWords = {
  invitationSubject: "{sender} asked you to sign {count} documents: {title}",
  invitationSubjectFill: "{sender} asked you to complete {count} documents: {title}",
  invitationIntro: "Hello {name}, {sender} at {workspace} has sent you {count} documents in “{title}” to review and sign.",
  invitationIntroFill: "Hello {name}, {sender} at {workspace} has sent you {count} documents in “{title}” to complete.",
  oneLink: "One link opens all of them. You go through them in order and finish once.",
  documentsHeading: "In this document collection:",
  reminderSubject: "Reminder: please sign {count} documents: {title}",
  reminderSubjectFill: "Reminder: please complete {count} documents: {title}",
  reminderIntro: "Hello {name}, this is a reminder that the {count} documents in “{title}” are waiting for you.",
  completedSubject: "Signed: {title} ({count} documents)",
  completedIntro: "Hello {name}, all {count} documents in “{title}” have been signed by everyone.",
  completedAttached: "The {count} signed copies are attached to this message.",
  completedSomeAttached: "{attached} of the {count} signed copies are attached. The others are too large to attach: open your signing link to download them.",
  completedNoneAttached: "The signed copies are too large to attach: open your signing link to download them.",
  completedFormSubject: "Received: {title} ({count} documents)",
  completedFormIntro: "Hello {name}, the details in all {count} documents of “{title}” have been submitted. Thank you.",
  completedFormAttached: "The {count} records of what was submitted are attached to this message.",
};

const MS: EnvelopeWords = {
  invitationSubject: "{sender} meminta anda menandatangani {count} dokumen: {title}",
  invitationSubjectFill: "{sender} meminta anda melengkapkan {count} dokumen: {title}",
  invitationIntro: "Helo {name}, {sender} di {workspace} telah menghantar {count} dokumen dalam “{title}” untuk anda semak dan tandatangani.",
  invitationIntroFill: "Helo {name}, {sender} di {workspace} telah menghantar {count} dokumen dalam “{title}” untuk anda lengkapkan.",
  oneLink: "Satu pautan membuka kesemuanya. Anda melaluinya mengikut turutan dan selesai sekali sahaja.",
  documentsHeading: "Dalam koleksi dokumen ini:",
  reminderSubject: "Peringatan: sila tandatangani {count} dokumen: {title}",
  reminderSubjectFill: "Peringatan: sila lengkapkan {count} dokumen: {title}",
  reminderIntro: "Helo {name}, ini peringatan bahawa {count} dokumen dalam “{title}” sedang menunggu anda.",
  completedSubject: "Telah ditandatangani: {title} ({count} dokumen)",
  completedIntro: "Helo {name}, kesemua {count} dokumen dalam “{title}” telah ditandatangani oleh semua pihak.",
  completedAttached: "{count} salinan yang ditandatangani dilampirkan pada mesej ini.",
  completedSomeAttached: "{attached} daripada {count} salinan yang ditandatangani dilampirkan. Selebihnya terlalu besar untuk dilampirkan: buka pautan penandatanganan anda untuk memuat turunnya.",
  completedNoneAttached: "Salinan yang ditandatangani terlalu besar untuk dilampirkan: buka pautan penandatanganan anda untuk memuat turunnya.",
  completedFormSubject: "Diterima: {title} ({count} dokumen)",
  completedFormIntro: "Helo {name}, butiran dalam kesemua {count} dokumen “{title}” telah dihantar. Terima kasih.",
  completedFormAttached: "{count} rekod apa yang dihantar dilampirkan pada mesej ini.",
};

const ZH: EnvelopeWords = {
  invitationSubject: "{sender} 请您签署 {count} 份文件：{title}",
  invitationSubjectFill: "{sender} 请您填写 {count} 份文件：{title}",
  invitationIntro: "{name}，您好。{workspace} 的 {sender} 向您发送了《{title}》中的 {count} 份文件，请查阅并签署。",
  invitationIntroFill: "{name}，您好。{workspace} 的 {sender} 向您发送了《{title}》中的 {count} 份文件，请填写。",
  oneLink: "一个链接即可打开全部文件。您按顺序逐份处理，最后一次性完成。",
  documentsHeading: "本文件集包括：",
  reminderSubject: "提醒：请签署 {count} 份文件：{title}",
  reminderSubjectFill: "提醒：请填写 {count} 份文件：{title}",
  reminderIntro: "{name}，您好。《{title}》中的 {count} 份文件仍在等待您处理。",
  completedSubject: "已签署：{title}（{count} 份文件）",
  completedIntro: "{name}，您好。《{title}》中的 {count} 份文件均已由所有人签署。",
  completedAttached: "{count} 份已签署的副本已附在此邮件中。",
  completedSomeAttached: "{count} 份已签署副本中有 {attached} 份已附在此邮件中，其余文件过大无法附上：请打开您的签署链接下载。",
  completedNoneAttached: "已签署的副本过大，无法作为附件：请打开您的签署链接下载。",
  completedFormSubject: "已收到：{title}（{count} 份文件）",
  completedFormIntro: "{name}，您好。《{title}》中 {count} 份文件的资料均已提交。谢谢。",
  completedFormAttached: "{count} 份提交记录已附在此邮件中。",
};

const KO: EnvelopeWords = {
  invitationSubject: "{sender}님이 문서 {count}건에 서명해 달라고 요청했습니다: {title}",
  invitationSubjectFill: "{sender}님이 문서 {count}건을 작성해 달라고 요청했습니다: {title}",
  invitationIntro: "{name}님, 안녕하세요. {workspace}의 {sender}님이 「{title}」의 문서 {count}건을 검토하고 서명하도록 보냈습니다.",
  invitationIntroFill: "{name}님, 안녕하세요. {workspace}의 {sender}님이 「{title}」의 문서 {count}건을 작성하도록 보냈습니다.",
  oneLink: "링크 하나로 모든 문서를 열 수 있습니다. 순서대로 진행한 뒤 한 번에 마칩니다.",
  documentsHeading: "이 문서 모음에 포함된 문서:",
  reminderSubject: "알림: 문서 {count}건에 서명해 주세요: {title}",
  reminderSubjectFill: "알림: 문서 {count}건을 작성해 주세요: {title}",
  reminderIntro: "{name}님, 「{title}」의 문서 {count}건이 기다리고 있다는 알림입니다.",
  completedSubject: "서명 완료: {title} (문서 {count}건)",
  completedIntro: "{name}님, 「{title}」의 문서 {count}건이 모두 서명되었습니다.",
  completedAttached: "서명된 사본 {count}건이 이 메시지에 첨부되어 있습니다.",
  completedSomeAttached: "서명된 사본 {count}건 중 {attached}건이 첨부되어 있습니다. 나머지는 용량이 커서 첨부할 수 없습니다. 서명 링크를 열어 내려받으세요.",
  completedNoneAttached: "서명된 사본은 용량이 커서 첨부할 수 없습니다. 서명 링크를 열어 내려받으세요.",
  completedFormSubject: "접수됨: {title} (문서 {count}건)",
  completedFormIntro: "{name}님, 「{title}」의 문서 {count}건의 정보가 모두 제출되었습니다. 감사합니다.",
  completedFormAttached: "제출 내용 기록 {count}건이 이 메시지에 첨부되어 있습니다.",
};

const DICT: Record<SignLocale, EnvelopeWords> = { en: EN, ms: MS, zh: ZH, ko: KO };

/** The envelope's own words in a language (English for one that is not known). */
export function envelopeWordsFor(locale: SignLocale): EnvelopeWords {
  return DICT[locale] ?? EN;
}

/** The documents as a numbered list, one per line. */
const numbered = (titles: readonly string[]) => titles.map((t, i) => `${i + 1}. ${t}`);

const listHtml = (heading: string, titles: readonly string[]) =>
  `<p style="font-size: 13px; color: #555; margin: 14px 0 4px;">${escapeHtml(heading)}</p><ol style="margin: 0 0 8px; padding-left: 22px; font-size: 14px; line-height: 1.6;">${titles.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ol>`;

export interface EnvelopeInvitationArgs {
  locale: SignLocale;
  workspace: string;
  sender: string;
  signerName: string;
  /** The envelope's title. */
  title: string;
  /** The titles of the documents, in order. */
  documents: readonly string[];
  /** The sender's own words, shown quoted. */
  message?: string | null;
  link: string;
  expiresAt?: Date | null;
  codeRequired: boolean;
  /** Every document is a form without a signature, or the person only fills in: the words say "complete", never "sign". */
  fill?: boolean;
  timeZone?: string;
}

/** One invitation for a person of an envelope: one link, the documents named, the expiry and the code note. */
export function envelopeInvitationEmail(a: EnvelopeInvitationArgs): Rendered {
  const w = wordsFor(a.locale);
  const e = envelopeWordsFor(a.locale);
  const v = { name: a.signerName, sender: a.sender, workspace: a.workspace, title: a.title, count: String(a.documents.length) };
  const subject = fill(a.fill ? e.invitationSubjectFill : e.invitationSubject, v);
  const intro = fill(a.fill ? e.invitationIntroFill : e.invitationIntro, v);
  const expiry = a.expiresAt ? fill(w.expires, { date: longDate(a.expiresAt, a.locale, a.timeZone) }) : "";
  const label = a.fill ? w.invitationButtonFill : w.invitationButton;
  const lines = [intro, "", e.documentsHeading, ...numbered(a.documents), "", e.oneLink];
  if (a.message?.trim()) lines.push("", fill(w.messageFrom, { sender: a.sender }), `“${a.message.trim()}”`);
  lines.push("", `${label}: ${a.link}`);
  if (expiry) lines.push("", expiry);
  if (a.codeRequired) lines.push(w.codeNote);
  lines.push("", w.linkIsPersonal, fill(w.notExpecting, { sender: a.sender }), "", fill(w.footer, { workspace: a.workspace }));
  const html = frame(
    [
      para(intro),
      listHtml(e.documentsHeading, a.documents),
      small(e.oneLink),
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

export interface EnvelopeReminderArgs extends Omit<EnvelopeInvitationArgs, "message" | "documents"> {
  /** The titles of the documents the person has not finished, in order. */
  documents: readonly string[];
}

/** A reminder for a person of an envelope: what is still to do, and a fresh link (the earlier one no longer works). */
export function envelopeReminderEmail(a: EnvelopeReminderArgs): Rendered {
  const w = wordsFor(a.locale);
  const e = envelopeWordsFor(a.locale);
  const v = { name: a.signerName, sender: a.sender, workspace: a.workspace, title: a.title, count: String(a.documents.length) };
  // one document left: the single-document reminder says it in the singular ("is waiting"), with the envelope's title
  const one = a.documents.length === 1;
  const intro = one ? fill(a.fill ? w.reminderFormIntro : w.reminderIntro, v) : fill(e.reminderIntro, v);
  const label = a.fill ? w.invitationButtonFill : w.invitationButton;
  const expiry = a.expiresAt ? fill(w.expires, { date: longDate(a.expiresAt, a.locale, a.timeZone) }) : "";
  const text = [intro, "", e.documentsHeading, ...numbered(a.documents), "", `${label}: ${a.link}`, w.reminderNewLink, ...(expiry ? ["", expiry] : []), "", fill(w.footer, { workspace: a.workspace })].join("\n");
  const html = frame(
    [para(intro), listHtml(e.documentsHeading, a.documents), button(label, a.link), small(w.reminderNewLink), expiry ? small(expiry) : "", `<p style="font-size: 12px; color: #999; word-break: break-all;">${escapeHtml(a.link)}</p>`].join("\n"),
    w,
    a.workspace,
  );
  const subject = one ? fill(a.fill ? w.reminderFormSubject : w.reminderSubject, v) : fill(a.fill ? e.reminderSubjectFill : e.reminderSubject, v);
  return { subject, html, text };
}

export interface EnvelopeCompletedArgs {
  locale: SignLocale;
  workspace: string;
  name: string;
  title: string;
  /** How many documents the envelope has, and how many of their signed copies are attached to this message. */
  count: number;
  attachedCount: number;
  /** Every document is a form without a signature: "received", and records instead of signed copies. */
  mode?: SignMode;
  /** Migration 178: how many of the documents have a certificate of their own, and how many of those certificates are attached. Absent when none has. */
  certificates?: { total: number; attached: number };
}

/** The one message each person (and the sender) gets when every document of the envelope is complete. */
export function envelopeCompletedEmail(a: EnvelopeCompletedArgs): Rendered {
  const w = wordsFor(a.locale);
  const e = envelopeWordsFor(a.locale);
  const formOnly = a.mode === "form";
  const v = { name: a.name, title: a.title, count: String(a.count), attached: String(a.attachedCount) };
  const intro = fill(formOnly ? e.completedFormIntro : e.completedIntro, v);
  // (the signed copies' own sentence is the same whichever way the certificate is kept: it says nothing about certificate pages)
  const note =
    a.attachedCount >= a.count
      ? fill(formOnly ? e.completedFormAttached : e.completedAttached, v)
      : a.attachedCount > 0
        ? fill(e.completedSomeAttached, v)
        : e.completedNoneAttached;
  const certificatesNote = a.certificates ? certificatesSentence(a.locale, a.certificates) : null;
  const text = [intro, note, ...(certificatesNote ? [certificatesNote] : []), "", fill(w.footer, { workspace: a.workspace })].join("\n");
  const html = frame([para(intro), para(note), certificatesNote ? para(certificatesNote) : ""].join("\n"), w, a.workspace);
  return { subject: fill(formOnly ? e.completedFormSubject : e.completedSubject, v), html, text };
}
