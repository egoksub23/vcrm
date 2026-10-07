// ============================================================
// What the signed-copy emails say about a document's certificate when it is a file of its own (migration 178), in the document's language.
// The people who get these emails are outside the workspace, so the words are written here (the same rule as messages.ts). Pure.
//
// A standalone certificate is attached as a separate file within the same attachment budget as the signed document, so each email says what is
// true of ITS attachments: the certificate is attached, or it could not be (and where it is to be had). A document sealed before migration 178 has no
// such file (its certificate is inside the signed PDF) and its emails say what they always said: these sentences are only used when there is one.
// ============================================================

import type { SignLocale } from "./types";

/** The same substitution messages.ts makes (kept here so messages.ts can use these words without a circular import). */
const fill = (template: string, values: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]).replace(/[\r\n\u2028\u2029]+/g, " ").trim() : m));

interface CertificateMailWords {
  /** One document: the certificate is attached as a separate file. */
  attached: string;
  /** One document: it is a separate file that could not be attached (a signer or the sender: their own signing link / the sender's page has it). */
  missing: string;
  /** One document, to a person who receives a copy: could not be attached, ask the sender. {sender} */
  missingAsk: string;
  /** The link text when a download address is given and the document has a certificate of its own. */
  linkAll: string;
  /** A collection: {count} certificates, all attached. */
  allAttached: string;
  /** A collection, to a signer: some attached. {attached} {count} */
  someAttachedLink: string;
  /** A collection, to a signer: none attached. */
  noneAttachedLink: string;
  /** A collection, to a person who receives a copy: some attached. {attached} {count} {sender} */
  someAttachedAsk: string;
  /** A collection, to a person who receives a copy: none attached. {sender} */
  noneAttachedAsk: string;
  /** One document, to a person who receives a copy: the signed copy is attached (no mention of certificate pages: they are a file of their own). */
  signedAttached: string;
  /** A collection, to a person who receives a copy: every signed copy is attached (no mention of certificate pages). {count} */
  signedCopiesAttached: string;
}

const EN: CertificateMailWords = {
  attached: "The certificate is attached to this message as a separate file. It records who took part and when.",
  missing: "The certificate is a separate file that could not be attached to this message.",
  missingAsk: "The certificate, which records who took part and when, is a separate file that could not be attached to this message: ask {sender} for it.",
  linkAll: "You can also download the signed document and its certificate here:",
  allAttached: "The {count} certificates are attached to this message as separate files. They record who took part and when.",
  someAttachedLink: "{attached} of the {count} certificates are attached to this message as separate files. The others could not be attached: open your signing link to download them.",
  noneAttachedLink: "The certificates are separate files and could not be attached to this message: open your signing link to download them.",
  someAttachedAsk: "{attached} of the {count} certificates are attached to this message as separate files. The others could not be attached: ask {sender} for them.",
  noneAttachedAsk: "The certificates are separate files and could not be attached to this message: ask {sender} for them.",
  signedAttached: "The signed copy is attached to this message.",
  signedCopiesAttached: "The {count} signed copies are attached to this message.",
};

const MS: CertificateMailWords = {
  attached: "Sijil dilampirkan pada mesej ini sebagai fail berasingan. Ia merekodkan siapa yang terlibat dan bila.",
  missing: "Sijil ialah fail berasingan yang tidak dapat dilampirkan pada mesej ini.",
  missingAsk: "Sijil, yang merekodkan siapa yang terlibat dan bila, ialah fail berasingan yang tidak dapat dilampirkan pada mesej ini: minta daripada {sender}.",
  linkAll: "Anda juga boleh memuat turun dokumen yang ditandatangani dan sijilnya di sini:",
  allAttached: "{count} sijil dilampirkan pada mesej ini sebagai fail berasingan. Ia merekodkan siapa yang terlibat dan bila.",
  someAttachedLink: "{attached} daripada {count} sijil dilampirkan pada mesej ini sebagai fail berasingan. Selebihnya tidak dapat dilampirkan: buka pautan penandatanganan anda untuk memuat turunnya.",
  noneAttachedLink: "Sijil ialah fail berasingan dan tidak dapat dilampirkan pada mesej ini: buka pautan penandatanganan anda untuk memuat turunnya.",
  someAttachedAsk: "{attached} daripada {count} sijil dilampirkan pada mesej ini sebagai fail berasingan. Selebihnya tidak dapat dilampirkan: minta daripada {sender}.",
  noneAttachedAsk: "Sijil ialah fail berasingan dan tidak dapat dilampirkan pada mesej ini: minta daripada {sender}.",
  signedAttached: "Salinan yang ditandatangani dilampirkan pada mesej ini.",
  signedCopiesAttached: "{count} salinan yang ditandatangani dilampirkan pada mesej ini.",
};

const ZH: CertificateMailWords = {
  attached: "证书已作为单独的文件附在本邮件中，其中记录了参与人及时间。",
  missing: "证书是单独的文件，无法附在本邮件中。",
  missingAsk: "记录参与人及时间的证书是单独的文件，无法附在本邮件中：请向 {sender} 索取。",
  linkAll: "您也可以在此下载已签署的文件及其证书：",
  allAttached: "{count} 份证书已作为单独的文件附在本邮件中，其中记录了参与人及时间。",
  someAttachedLink: "{count} 份证书中有 {attached} 份已作为单独的文件附在本邮件中，其余无法附上：请打开您的签署链接下载。",
  noneAttachedLink: "证书是单独的文件，无法附在本邮件中：请打开您的签署链接下载。",
  someAttachedAsk: "{count} 份证书中有 {attached} 份已作为单独的文件附在本邮件中，其余无法附上：请向 {sender} 索取。",
  noneAttachedAsk: "证书是单独的文件，无法附在本邮件中：请向 {sender} 索取。",
  signedAttached: "已签署的副本见本邮件附件。",
  signedCopiesAttached: "{count} 份已签署的副本见本邮件附件。",
};

const KO: CertificateMailWords = {
  attached: "증명서가 별도의 파일로 이 메일에 첨부되어 있습니다. 누가 언제 참여했는지 기록되어 있습니다.",
  missing: "증명서는 별도의 파일이며 이 메일에 첨부할 수 없었습니다.",
  missingAsk: "누가 언제 참여했는지 기록한 증명서는 별도의 파일이며 이 메일에 첨부할 수 없었습니다. {sender}님께 요청해 주세요.",
  linkAll: "서명된 문서와 증명서는 여기에서도 내려받을 수 있습니다:",
  allAttached: "증명서 {count}건이 별도의 파일로 이 메일에 첨부되어 있습니다. 누가 언제 참여했는지 기록되어 있습니다.",
  someAttachedLink: "증명서 {count}건 중 {attached}건이 별도의 파일로 첨부되어 있습니다. 나머지는 첨부할 수 없었습니다. 서명 링크를 열어 내려받으세요.",
  noneAttachedLink: "증명서는 별도의 파일이며 첨부할 수 없었습니다. 서명 링크를 열어 내려받으세요.",
  someAttachedAsk: "증명서 {count}건 중 {attached}건이 별도의 파일로 첨부되어 있습니다. 나머지는 첨부할 수 없었습니다. {sender}님께 요청해 주세요.",
  noneAttachedAsk: "증명서는 별도의 파일이며 첨부할 수 없었습니다. {sender}님께 요청해 주세요.",
  signedAttached: "서명본이 이 메일에 첨부되어 있습니다.",
  signedCopiesAttached: "서명본 {count}건이 이 메일에 첨부되어 있습니다.",
};

const DICT: Record<SignLocale, CertificateMailWords> = { en: EN, ms: MS, zh: ZH, ko: KO };

export const certificateMailWords = (locale: SignLocale): CertificateMailWords => DICT[locale] ?? EN;

/** What the certificate of ONE document needs said, for an email that attaches (or does not attach) it. `null`: nothing (no standalone certificate). */
export type CertificateState = "none" | "attached" | "missing";

/** The sentence about one document's certificate, or null when it has no file of its own. `sender` is named for a person who has to ask for it. */
export function certificateSentence(locale: SignLocale, state: CertificateState, opts: { sender?: string } = {}): string | null {
  const c = certificateMailWords(locale);
  if (state === "attached") return c.attached;
  if (state === "missing") return opts.sender ? fill(c.missingAsk, { sender: opts.sender }) : c.missing;
  return null;
}

/** The sentence about a collection's certificates (`total` have a file of their own, `attached` of them are on this message), or null when none has. */
export function certificatesSentence(locale: SignLocale, a: { total: number; attached: number; sender?: string }): string | null {
  if (a.total <= 0) return null;
  const c = certificateMailWords(locale);
  const v = { count: String(a.total), attached: String(a.attached), sender: a.sender ?? "" };
  if (a.attached >= a.total) return fill(c.allAttached, v);
  if (a.attached > 0) return fill(a.sender ? c.someAttachedAsk : c.someAttachedLink, v);
  return fill(a.sender ? c.noneAttachedAsk : c.noneAttachedLink, v);
}
