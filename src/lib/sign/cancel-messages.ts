// ============================================================
// The words of the message that tells people a COMPLETED document (or a whole document collection) was cancelled (migration 181), when the person who
// cancelled it ticked "Notify everyone". The people are outside the workspace and read it in the document's language, so the words are written here (the
// same rule as messages.ts, whose frame and footer they share). Pure.
//
// What it says: which document, who cancelled it (the workspace), on what date, the reason, and that the signed copy the person already has remains a
// record of what was signed but is no longer in force. What it never carries: a signing link, the document, or any file. It is not a request to do
// anything, so it has no button.
// ============================================================

import { escapeHtml, fill, frame, longDate, para, small, wordsFor, type Rendered } from "./messages";
import type { SignLocale, SignMode } from "./types";

interface CancelWords {
  subject: string; // {title}
  collectionSubject: string; // {title}
  intro: string; // {title} {reference} {workspace} {date}
  introNoReference: string; // {title} {workspace} {date}
  collectionIntro: string; // {title} {reference} {count} {workspace} {date}
  reason: string; // {reason}
  record: string;
  recordForm: string;
  collectionRecord: string;
  collectionRecordForm: string;
}

const EN: CancelWords = {
  subject: "Cancelled: {title}",
  collectionSubject: "Cancelled: {title} ({count} documents)",
  intro: "“{title}” ({reference}) was cancelled by {workspace} on {date}.",
  introNoReference: "“{title}” was cancelled by {workspace} on {date}.",
  collectionIntro: "“{title}” ({reference}), a collection of {count} documents, was cancelled by {workspace} on {date}.",
  reason: "Reason: {reason}",
  record: "The signed copy you already have remains a record of what was signed; it is no longer in force.",
  recordForm: "The record you already have remains a record of what was submitted; it is no longer in force.",
  collectionRecord: "The signed copies you already have remain a record of what was signed; they are no longer in force.",
  collectionRecordForm: "The records you already have remain a record of what was submitted; they are no longer in force.",
};

const MS: CancelWords = {
  subject: "Dibatalkan: {title}",
  collectionSubject: "Dibatalkan: {title} ({count} dokumen)",
  intro: "“{title}” ({reference}) telah dibatalkan oleh {workspace} pada {date}.",
  introNoReference: "“{title}” telah dibatalkan oleh {workspace} pada {date}.",
  collectionIntro: "“{title}” ({reference}), satu koleksi {count} dokumen, telah dibatalkan oleh {workspace} pada {date}.",
  reason: "Sebab: {reason}",
  record: "Salinan yang ditandatangani yang anda sudah ada kekal sebagai rekod apa yang ditandatangani; ia tidak lagi berkuat kuasa.",
  recordForm: "Rekod yang anda sudah ada kekal sebagai rekod apa yang dihantar; ia tidak lagi berkuat kuasa.",
  collectionRecord: "Salinan yang ditandatangani yang anda sudah ada kekal sebagai rekod apa yang ditandatangani; ia tidak lagi berkuat kuasa.",
  collectionRecordForm: "Rekod yang anda sudah ada kekal sebagai rekod apa yang dihantar; ia tidak lagi berkuat kuasa.",
};

const ZH: CancelWords = {
  subject: "已取消：{title}",
  collectionSubject: "已取消：{title}（{count} 份文件）",
  intro: "《{title}》（{reference}）已于 {date} 被 {workspace} 取消。",
  introNoReference: "《{title}》已于 {date} 被 {workspace} 取消。",
  collectionIntro: "《{title}》（{reference}）共 {count} 份文件，已于 {date} 被 {workspace} 取消。",
  reason: "原因：{reason}",
  record: "您已持有的已签署副本仍是已签署内容的记录，但已不再有效。",
  recordForm: "您已持有的记录仍是所提交内容的记录，但已不再有效。",
  collectionRecord: "您已持有的已签署副本仍是已签署内容的记录，但已不再有效。",
  collectionRecordForm: "您已持有的记录仍是所提交内容的记录，但已不再有效。",
};

const KO: CancelWords = {
  subject: "취소됨: {title}",
  collectionSubject: "취소됨: {title} (문서 {count}건)",
  intro: "“{title}”({reference})이(가) {date}에 {workspace}에 의해 취소되었습니다.",
  introNoReference: "“{title}”이(가) {date}에 {workspace}에 의해 취소되었습니다.",
  collectionIntro: "“{title}”({reference}) 문서 {count}건이 {date}에 {workspace}에 의해 취소되었습니다.",
  reason: "사유: {reason}",
  record: "이미 가지고 계신 서명본은 서명된 내용의 기록으로 남지만, 더 이상 효력이 없습니다.",
  recordForm: "이미 가지고 계신 기록은 제출된 내용의 기록으로 남지만, 더 이상 효력이 없습니다.",
  collectionRecord: "이미 가지고 계신 서명본은 서명된 내용의 기록으로 남지만, 더 이상 효력이 없습니다.",
  collectionRecordForm: "이미 가지고 계신 기록은 제출된 내용의 기록으로 남지만, 더 이상 효력이 없습니다.",
};

const DICT: Record<SignLocale, CancelWords> = { en: EN, ms: MS, zh: ZH, ko: KO };
export const cancelWordsFor = (locale: SignLocale): CancelWords => DICT[locale] ?? EN;

export interface CancelEmailArgs {
  locale: SignLocale;
  /** The workspace's name: who cancelled it, as far as the reader is concerned. */
  workspace: string;
  title: string;
  reference: string | null;
  /** When it was cancelled (shown as a date in the workspace's time zone). */
  cancelledAt: Date;
  /** What the person who cancelled it wrote. */
  reason: string;
  /** A collection: how many documents it holds. Absent or 1 for a document on its own. */
  count?: number;
  mode?: SignMode;
  timeZone?: string;
}

/** The message about a cancelled document or collection. One line of what happened, the reason, and what it means for the copy the person holds. */
export function cancelEmail(a: CancelEmailArgs): Rendered {
  const w = wordsFor(a.locale);
  const c = cancelWordsFor(a.locale);
  const collection = (a.count ?? 1) > 1;
  const formOnly = a.mode === "form";
  const date = longDate(a.cancelledAt, a.locale, a.timeZone);
  const v = { title: a.title, reference: a.reference ?? "", workspace: a.workspace, date, count: String(a.count ?? 1) };
  const subject = fill(collection ? c.collectionSubject : c.subject, v);
  const intro = fill(collection ? c.collectionIntro : a.reference ? c.intro : c.introNoReference, v);
  const reason = fill(c.reason, { reason: a.reason });
  const record = collection ? (formOnly ? c.collectionRecordForm : c.collectionRecord) : formOnly ? c.recordForm : c.record;
  // the reason is the person's own words: shown on lines of its own, quoted, never as part of a sentence of ours
  const reasonHtml = `<div style="border-left: 3px solid #c7c3f5; padding: 2px 14px; margin: 16px 0; color: #444;"><p style="font-size: 14px; line-height: 1.5; margin: 0; white-space: pre-wrap;">${escapeHtml(reason)}</p></div>`;
  return {
    subject,
    html: frame([para(intro), reasonHtml, small(record)].join("\n"), w, a.workspace),
    text: [intro, "", reason, "", record, "", fill(w.footer, { workspace: a.workspace })].join("\n"),
  };
}
