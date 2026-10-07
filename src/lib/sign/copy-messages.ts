// ============================================================
// The words of the message a person who RECEIVES A COPY gets (migration 175): the signed copy of one document, or the signed copies of every
// document of a collection, in ONE email. They are outside the workspace and read it in the document's language, so the words are written
// here (the same rule as messages.ts, whose frame and footer they share). Pure.
//
// The signed PDF is attached while it fits; the sealed file already holds the certificate pages, so the attachment is the proof. A copy
// that is too large to attach is never sent as a download link (a link would open the file to anyone who holds it): the message says the
// sender can provide it and gives the public page that checks a signed document, which shows no document, only whether it is genuine.
// ============================================================

import { button, escapeHtml, fill, frame, para, small, wordsFor, type Rendered } from "./messages";
import type { SignLocale, SignMode } from "./types";

interface CopyWords {
  subject: string; // {title}
  intro: string; // {name} {sender} {workspace} {title}
  attached: string;
  tooLarge: string; // {sender}
  verify: string;
  nothingToDo: string;
  formSubject: string; // {title}
  formIntro: string; // {name} {sender} {workspace} {title}
  formAttached: string;
  collectionSubject: string; // {title} {count}
  collectionIntro: string; // {name} {sender} {workspace} {title} {count}
  collectionAttached: string; // {count}
  collectionSomeAttached: string; // {attached} {count} {sender}
  collectionNoneAttached: string; // {sender}
  collectionFormSubject: string; // {title} {count}
  collectionFormIntro: string; // {name} {sender} {workspace} {title} {count}
  collectionFormAttached: string; // {count}
}

const EN: CopyWords = {
  subject: "Signed copy: {title}",
  intro: "Hello {name}, {sender} at {workspace} asked us to send you a copy of “{title}”. Everyone has signed it.",
  attached: "The signed copy is attached to this message. It includes the certificate pages that record who signed and when.",
  tooLarge: "The signed copy is too large to attach. Ask {sender} for it.",
  verify: "You can check that a copy is genuine here:",
  nothingToDo: "You were not asked to sign anything. This copy is for your records.",
  formSubject: "Received: {title}",
  formIntro: "Hello {name}, {sender} at {workspace} asked us to send you a record of the details submitted in “{title}”.",
  formAttached: "A record of what was submitted is attached to this message.",
  collectionSubject: "Signed copies: {title} ({count} documents)",
  collectionIntro: "Hello {name}, {sender} at {workspace} asked us to send you a copy of each of the {count} documents in “{title}”. Everyone has signed them.",
  collectionAttached: "The {count} signed copies are attached to this message. They include the certificate pages that record who signed and when.",
  collectionSomeAttached: "{attached} of the {count} signed copies are attached. The others are too large to attach: ask {sender} for them.",
  collectionNoneAttached: "The signed copies are too large to attach. Ask {sender} for them.",
  collectionFormSubject: "Received: {title} ({count} documents)",
  collectionFormIntro: "Hello {name}, {sender} at {workspace} asked us to send you a record of the details submitted in each of the {count} documents of “{title}”.",
  collectionFormAttached: "The {count} records of what was submitted are attached to this message.",
};

const MS: CopyWords = {
  subject: "Salinan yang ditandatangani: {title}",
  intro: "Helo {name}, {sender} di {workspace} meminta kami menghantar salinan “{title}” kepada anda. Semua pihak telah menandatanganinya.",
  attached: "Salinan yang ditandatangani dilampirkan pada mesej ini. Ia termasuk halaman sijil yang merekodkan siapa yang menandatangani dan bila.",
  tooLarge: "Salinan yang ditandatangani terlalu besar untuk dilampirkan. Minta daripada {sender}.",
  verify: "Anda boleh menyemak sama ada sesuatu salinan tulen di sini:",
  nothingToDo: "Anda tidak diminta menandatangani apa-apa. Salinan ini untuk rekod anda.",
  formSubject: "Diterima: {title}",
  formIntro: "Helo {name}, {sender} di {workspace} meminta kami menghantar rekod butiran yang dihantar dalam “{title}” kepada anda.",
  formAttached: "Rekod apa yang dihantar dilampirkan pada mesej ini.",
  collectionSubject: "Salinan yang ditandatangani: {title} ({count} dokumen)",
  collectionIntro: "Helo {name}, {sender} di {workspace} meminta kami menghantar salinan setiap satu daripada {count} dokumen dalam “{title}” kepada anda. Semua pihak telah menandatanganinya.",
  collectionAttached: "{count} salinan yang ditandatangani dilampirkan pada mesej ini. Ia termasuk halaman sijil yang merekodkan siapa yang menandatangani dan bila.",
  collectionSomeAttached: "{attached} daripada {count} salinan yang ditandatangani dilampirkan. Selebihnya terlalu besar untuk dilampirkan: minta daripada {sender}.",
  collectionNoneAttached: "Salinan yang ditandatangani terlalu besar untuk dilampirkan. Minta daripada {sender}.",
  collectionFormSubject: "Diterima: {title} ({count} dokumen)",
  collectionFormIntro: "Helo {name}, {sender} di {workspace} meminta kami menghantar rekod butiran yang dihantar dalam setiap satu daripada {count} dokumen “{title}” kepada anda.",
  collectionFormAttached: "{count} rekod apa yang dihantar dilampirkan pada mesej ini.",
};

const ZH: CopyWords = {
  subject: "已签署的副本：{title}",
  intro: "{name}，您好。{workspace} 的 {sender} 请我们把《{title}》的副本发给您。所有人均已签署。",
  attached: "已签署的副本见本邮件附件，其中包含记录签署人及签署时间的证书页。",
  tooLarge: "已签署的副本太大，无法作为附件发送。请向 {sender} 索取。",
  verify: "您可以在此核实副本是否真实：",
  nothingToDo: "您无需签署任何内容。这份副本仅供您留存。",
  formSubject: "已收到：{title}",
  formIntro: "{name}，您好。{workspace} 的 {sender} 请我们把《{title}》中所提交资料的记录发给您。",
  formAttached: "所提交内容的记录见本邮件附件。",
  collectionSubject: "已签署的副本：{title}（{count} 份文件）",
  collectionIntro: "{name}，您好。{workspace} 的 {sender} 请我们把《{title}》中 {count} 份文件各自的副本发给您。所有人均已签署。",
  collectionAttached: "{count} 份已签署的副本见本邮件附件，其中包含记录签署人及签署时间的证书页。",
  collectionSomeAttached: "已附上 {count} 份已签署副本中的 {attached} 份。其余的太大，无法作为附件发送，请向 {sender} 索取。",
  collectionNoneAttached: "已签署的副本太大，无法作为附件发送。请向 {sender} 索取。",
  collectionFormSubject: "已收到：{title}（{count} 份文件）",
  collectionFormIntro: "{name}，您好。{workspace} 的 {sender} 请我们把《{title}》中 {count} 份文件各自所提交资料的记录发给您。",
  collectionFormAttached: "{count} 份所提交内容的记录见本邮件附件。",
};

const KO: CopyWords = {
  subject: "서명 사본: {title}",
  intro: "{name}님, {workspace}의 {sender}님이 “{title}”의 사본을 보내 드리도록 요청했습니다. 모든 분의 서명이 완료되었습니다.",
  attached: "서명본이 이 메일에 첨부되어 있습니다. 누가 언제 서명했는지 기록한 인증서 페이지가 포함되어 있습니다.",
  tooLarge: "서명본이 너무 커서 첨부할 수 없습니다. {sender}님께 요청해 주세요.",
  verify: "사본이 진본인지 여기에서 확인할 수 있습니다:",
  nothingToDo: "서명하실 내용은 없습니다. 이 사본은 보관용입니다.",
  formSubject: "접수됨: {title}",
  formIntro: "{name}님, {workspace}의 {sender}님이 “{title}”에 제출된 정보의 기록을 보내 드리도록 요청했습니다.",
  formAttached: "제출된 내용의 기록이 이 메일에 첨부되어 있습니다.",
  collectionSubject: "서명 사본: {title} (문서 {count}건)",
  collectionIntro: "{name}님, {workspace}의 {sender}님이 “{title}”의 문서 {count}건 각각의 사본을 보내 드리도록 요청했습니다. 모든 분의 서명이 완료되었습니다.",
  collectionAttached: "서명본 {count}건이 이 메일에 첨부되어 있습니다. 누가 언제 서명했는지 기록한 인증서 페이지가 포함되어 있습니다.",
  collectionSomeAttached: "서명본 {count}건 중 {attached}건이 첨부되어 있습니다. 나머지는 너무 커서 첨부할 수 없습니다. {sender}님께 요청해 주세요.",
  collectionNoneAttached: "서명본이 너무 커서 첨부할 수 없습니다. {sender}님께 요청해 주세요.",
  collectionFormSubject: "접수됨: {title} (문서 {count}건)",
  collectionFormIntro: "{name}님, {workspace}의 {sender}님이 “{title}”의 문서 {count}건 각각에 제출된 정보의 기록을 보내 드리도록 요청했습니다.",
  collectionFormAttached: "제출된 내용의 기록 {count}건이 이 메일에 첨부되어 있습니다.",
};

const DICT: Record<SignLocale, CopyWords> = { en: EN, ms: MS, zh: ZH, ko: KO };
export const copyWordsFor = (locale: SignLocale): CopyWords => DICT[locale] ?? EN;

export interface CopyEmailArgs {
  locale: SignLocale;
  workspace: string;
  /** The person who sent the document: who to ask for a copy that was too large to attach. */
  sender: string;
  name: string;
  title: string;
  /** Whether the signed copy is attached to this message. */
  attached: boolean;
  /** The public page that checks a signed document (shows no document). Named when the copy could not be attached. */
  verifyUrl?: string;
  mode?: SignMode;
}

/** The signed copy of one document, to a person who receives a copy. */
export function copyEmail(a: CopyEmailArgs): Rendered {
  const w = wordsFor(a.locale);
  const c = copyWordsFor(a.locale);
  const formOnly = a.mode === "form";
  const v = { name: a.name, sender: a.sender, workspace: a.workspace, title: a.title };
  const intro = fill(formOnly ? c.formIntro : c.intro, v);
  const note = a.attached ? (formOnly ? c.formAttached : c.attached) : fill(c.tooLarge, v);
  const lines = [intro, note];
  if (!a.attached && a.verifyUrl) lines.push(c.verify, a.verifyUrl);
  lines.push("", c.nothingToDo, "", fill(w.footer, { workspace: a.workspace }));
  const html = frame([para(intro), para(note), !a.attached && a.verifyUrl ? `${small(c.verify)}${button(a.title, a.verifyUrl)}` : "", small(c.nothingToDo)].join("\n"), w, a.workspace);
  return { subject: fill(formOnly ? c.formSubject : c.subject, v), html, text: lines.join("\n") };
}

export interface EnvelopeCopyEmailArgs extends Omit<CopyEmailArgs, "attached" | "verifyUrl"> {
  /** How many documents the collection has, and how many of their signed copies are attached to this message. */
  count: number;
  attachedCount: number;
  /** The documents whose signed copy is NOT attached, each with the public page that checks it. */
  notAttached?: readonly { title: string; verifyUrl: string }[];
}

/** The signed copies of every document of a collection, in ONE message to a person who receives a copy. */
export function envelopeCopyEmail(a: EnvelopeCopyEmailArgs): Rendered {
  const w = wordsFor(a.locale);
  const c = copyWordsFor(a.locale);
  const formOnly = a.mode === "form";
  const v = { name: a.name, sender: a.sender, workspace: a.workspace, title: a.title, count: String(a.count), attached: String(a.attachedCount) };
  const intro = fill(formOnly ? c.collectionFormIntro : c.collectionIntro, v);
  const note = a.attachedCount >= a.count ? fill(formOnly ? c.collectionFormAttached : c.collectionAttached, v) : a.attachedCount > 0 ? fill(c.collectionSomeAttached, v) : fill(c.collectionNoneAttached, v);
  const missing = a.notAttached ?? [];
  const lines = [intro, note];
  if (missing.length > 0) lines.push(c.verify, ...missing.map((m) => `${m.title}: ${m.verifyUrl}`));
  lines.push("", c.nothingToDo, "", fill(w.footer, { workspace: a.workspace }));
  const links = missing.length > 0 ? [small(c.verify), ...missing.map((m) => `<p style="font-size: 13px; line-height: 1.5; word-break: break-all;">${escapeHtml(m.title)}: <a href="${escapeHtml(m.verifyUrl)}">${escapeHtml(m.verifyUrl)}</a></p>`)].join("\n") : "";
  const html = frame([para(intro), para(note), links, small(c.nothingToDo)].join("\n"), w, a.workspace);
  return { subject: fill(formOnly ? c.collectionFormSubject : c.collectionSubject, v), html, text: lines.join("\n") };
}
