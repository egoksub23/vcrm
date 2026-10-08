// ============================================================
// The words on the certificate pages of a signed document, in the document's language: the labels,
// and one sentence for each kind of event in the history. Pure.
// ============================================================

import { DEFAULT_CERTIFICATE_LABELS } from "./pdf/certificate";
import type { CertificateLabels } from "./pdf/types";
import { fill, longDate } from "./messages";
import type { SignLocale, SignMode } from "./types";

const MS: CertificateLabels = {
  heading: "Perakuan Penyempurnaan",
  reference: "Rujukan",
  document: "Dokumen",
  pages: "Halaman",
  sentOn: "Dihantar",
  completedOn: "Disempurnakan",
  fingerprint: "SHA-256 fail seperti dihantar",
  signers: "Penandatangan",
  name: "Nama",
  email: "E-mel",
  role: "Peranan",
  status: "Status",
  signedOn: "Ditandatangani",
  ip: "Alamat IP",
  device: "Peranti",
  channel: "Dihantar melalui",
  history: "Sejarah",
  chainHead: "Cap jari jejak audit",
  verify: "Semak dokumen ini",
  statusSigned: "Ditandatangani",
  statusDeclined: "Ditolak",
  statusPending: "Belum ditandatangani",
  note: "Peristiwa penandatanganan di atas disimpan dalam jejak audit; setiap catatan membawa cap jari catatan sebelumnya. Fail ini dimeterai dengan tandatangan digital: jika mana-mana halamannya diubah selepas dimeterai, pembaca PDF akan memberitahu.",
  page: "Halaman perakuan",
  of: "daripada",
  documentId: "ID dokumen",
  signedFile: "Dokumen bertandatangan",
  signedFingerprint: "SHA-256 dokumen bertandatangan",
  standaloneNote:
    "Sijil ini ialah fail berasingan. Ia meliputi dokumen bertandatangan yang dinamakan di atas: cap jari SHA-256 dokumen itu ditulis di sini dan sesiapa boleh menyemak salinan dengannya di halaman pengesahan. Peristiwa penandatanganan di atas disimpan dalam jejak audit; setiap catatan membawa cap jari catatan sebelumnya. Sijil ini dimeterai dengan tandatangan digital: jika mana-mana halamannya diubah selepas dimeterai, pembaca PDF akan memberitahu.",
};

const ZH: CertificateLabels = {
  heading: "完成证书",
  reference: "编号",
  document: "文件",
  pages: "页数",
  sentOn: "发送时间",
  completedOn: "完成时间",
  fingerprint: "发送时文件的 SHA-256",
  signers: "签署人",
  name: "姓名",
  email: "电子邮件",
  role: "角色",
  status: "状态",
  signedOn: "签署时间",
  ip: "IP 地址",
  device: "设备",
  channel: "发送方式",
  history: "历史记录",
  chainHead: "审计记录指纹",
  verify: "核验此文件",
  statusSigned: "已签署",
  statusDeclined: "已拒绝",
  statusPending: "未签署",
  note: "上述签署事件保存在审计记录中，每条记录都带有前一条记录的指纹。本文件以数字签名封存：封存之后若任何一页被改动，PDF 阅读器会提示。",
  page: "证书页",
  of: "共",
  documentId: "文件 ID",
  signedFile: "已签署文件",
  signedFingerprint: "已签署文件的 SHA-256",
  standaloneNote:
    "本证书是一个独立的文件，涵盖上面所列的已签署文件：该文件的 SHA-256 指纹写在此处，任何人都可以在核验页面上用它核对手中的副本。上述签署事件保存在审计记录中，每条记录都带有前一条记录的指纹。本证书以数字签名封存：封存之后若任何一页被改动，PDF 阅读器会提示。",
};

const KO: CertificateLabels = {
  heading: "완료 증명서",
  reference: "문서 번호",
  document: "문서",
  pages: "페이지 수",
  sentOn: "발송",
  completedOn: "완료",
  fingerprint: "발송 시점 파일의 SHA-256",
  signers: "서명자",
  name: "이름",
  email: "이메일",
  role: "역할",
  status: "상태",
  signedOn: "서명 일시",
  ip: "IP 주소",
  device: "기기",
  channel: "발송 방법",
  history: "이력",
  chainHead: "감사 기록 지문",
  verify: "이 문서 확인",
  statusSigned: "서명함",
  statusDeclined: "거부함",
  statusPending: "미서명",
  note: "위의 서명 이벤트는 감사 기록에 보관되며, 각 항목에는 바로 앞 항목의 지문이 담겨 있습니다. 이 파일은 디지털 서명으로 봉인되었으며, 봉인 후 어느 페이지든 변경되면 PDF 리더가 알려 줍니다.",
  page: "증명서 페이지",
  of: "/",
  documentId: "문서 ID",
  signedFile: "서명된 문서",
  signedFingerprint: "서명된 문서의 SHA-256",
  standaloneNote:
    "이 증명서는 별도의 파일입니다. 위에 적힌 서명된 문서를 대상으로 하며, 그 문서의 SHA-256 지문이 여기에 기재되어 있어 누구나 확인 페이지에서 사본을 대조할 수 있습니다. 위의 서명 이벤트는 감사 기록에 보관되며, 각 항목에는 바로 앞 항목의 지문이 담겨 있습니다. 이 증명서는 디지털 서명으로 봉인되었으며, 봉인 후 어느 페이지든 변경되면 PDF 리더가 알려 줍니다.",
};

const LABELS: Record<SignLocale, CertificateLabels> = { en: DEFAULT_CERTIFICATE_LABELS, ms: MS, zh: ZH, ko: KO };

/**
 * What a form without a signature (migration 169) says differently on its certificate pages: nobody signed, people submitted.
 * Everything else (the table, the QR code, the fingerprints) is the same page.
 */
const FORM_LABELS: Record<SignLocale, Partial<CertificateLabels>> = {
  en: {
    heading: "Certificate of Submission",
    fingerprint: "Fingerprint of the form as sent",
    signers: "People who submitted",
    signedOn: "Submitted",
    statusSigned: "Submitted",
    statusPending: "Not submitted",
    note: "The events above are kept in an audit trail in which each entry carries a fingerprint of the one before it. This file records what was submitted and is sealed with a digital signature: if any page of it is changed after sealing, a PDF reader will say so.",
    signedFile: "Sealed record",
    signedFingerprint: "SHA-256 of the sealed record",
    standaloneNote:
      "This certificate is a separate file. It covers the sealed record of what was submitted, named above: that file's SHA-256 fingerprint is written here, and anyone can check a copy against it on the verification page. The events above are kept in an audit trail in which each entry carries a fingerprint of the one before it. This certificate is sealed with a digital signature: if any page of it is changed after sealing, a PDF reader will say so.",
  },
  ms: {
    heading: "Perakuan Penghantaran",
    fingerprint: "Cap jari borang seperti dihantar",
    signers: "Pihak yang menghantar",
    signedOn: "Dihantar",
    statusSigned: "Dihantar",
    statusPending: "Belum dihantar",
    note: "Peristiwa di atas disimpan dalam jejak audit; setiap catatan membawa cap jari catatan sebelumnya. Fail ini merekodkan apa yang dihantar dan dimeterai dengan tandatangan digital: jika mana-mana halamannya diubah selepas dimeterai, pembaca PDF akan memberitahu.",
    signedFile: "Rekod termeterai",
    signedFingerprint: "SHA-256 rekod termeterai",
    standaloneNote:
      "Sijil ini ialah fail berasingan. Ia meliputi rekod termeterai tentang apa yang dihantar, yang dinamakan di atas: cap jari SHA-256 fail itu ditulis di sini dan sesiapa boleh menyemak salinan dengannya di halaman pengesahan. Peristiwa di atas disimpan dalam jejak audit; setiap catatan membawa cap jari catatan sebelumnya. Sijil ini dimeterai dengan tandatangan digital: jika mana-mana halamannya diubah selepas dimeterai, pembaca PDF akan memberitahu.",
  },
  zh: {
    heading: "提交证书",
    fingerprint: "发送时表格的指纹",
    signers: "提交人",
    signedOn: "提交时间",
    statusSigned: "已提交",
    statusPending: "未提交",
    note: "上述事件保存在审计记录中，每条记录都带有前一条记录的指纹。本文件记录所提交的内容，并以数字签名封存：封存之后若任何一页被改动，PDF 阅读器会提示。",
    signedFile: "封存的记录",
    signedFingerprint: "封存记录的 SHA-256",
    standaloneNote:
      "本证书是一个独立的文件，涵盖上面所列的、记录所提交内容的封存记录：该文件的 SHA-256 指纹写在此处，任何人都可以在核验页面上用它核对手中的副本。上述事件保存在审计记录中，每条记录都带有前一条记录的指纹。本证书以数字签名封存：封存之后若任何一页被改动，PDF 阅读器会提示。",
  },
  ko: {
    heading: "제출 증명서",
    fingerprint: "발송 시점 양식의 지문",
    signers: "제출자",
    signedOn: "제출 일시",
    statusSigned: "제출함",
    statusPending: "미제출",
    note: "위의 이벤트는 감사 기록에 보관되며, 각 항목에는 바로 앞 항목의 지문이 담겨 있습니다. 이 파일은 제출된 내용을 기록하며 디지털 서명으로 봉인되었습니다. 봉인 후 어느 페이지든 변경되면 PDF 리더가 알려 줍니다.",
    signedFile: "봉인된 기록",
    signedFingerprint: "봉인된 기록의 SHA-256",
    standaloneNote:
      "이 증명서는 별도의 파일입니다. 위에 적힌, 제출된 내용을 기록한 봉인된 기록을 대상으로 하며, 그 파일의 SHA-256 지문이 여기에 기재되어 있어 누구나 확인 페이지에서 사본을 대조할 수 있습니다. 위의 이벤트는 감사 기록에 보관되며, 각 항목에는 바로 앞 항목의 지문이 담겨 있습니다. 이 증명서는 디지털 서명으로 봉인되었으며, 봉인 후 어느 페이지든 변경되면 PDF 리더가 알려 줍니다.",
  },
};

export function certificateLabels(locale: SignLocale, mode: SignMode = "sign"): CertificateLabels {
  const base = LABELS[locale] ?? DEFAULT_CERTIFICATE_LABELS;
  return mode === "form" ? { ...base, ...(FORM_LABELS[locale] ?? FORM_LABELS.en) } : base;
}

type EventWords = Record<string, string>;

const EVENTS: Record<SignLocale, EventWords> = {
  en: {
    created: "{sender} created the document",
    sent: "{sender} sent the document",
    invited: "{actor} was invited",
    resent: "A new link was sent to {actor}",
    reminded: "A reminder was sent to {actor}",
    recipient_changed: "The recipient {actor} was changed",
    viewed: "{actor} opened the document",
    code_sent: "A verification code was sent to {actor}",
    code_verified: "{actor} entered the verification code",
    code_verified_halo: "{actor} was identified by their Halo sign-in (verification method: Halo login)",
    code_failed: "{actor} entered a wrong verification code",
    consented: "{actor} agreed to sign electronically",
    signed: "{actor} signed",
    submitted: "{actor} completed their part",
    declined: "{actor} declined to sign",
    all_signed: "Everyone had signed",
    sealed: "The document was sealed",
    completed: "The document was completed",
    voided: "{sender} cancelled the document",
    expired: "The document expired",
    delivery_failed: "A message to {actor} could not be delivered",
    uploaded: "{actor} uploaded {name} (fingerprint {hash})",
    upload_removed: "{actor} removed the upload {name}",
    expiry_extended: "{sender} extended the expiry date to {date}",
    expiry_extended_plain: "{sender} extended the expiry date",
    invitedAfter: "{actor} was invited because {name} finished",
    invitedAfterStep: "{actor} was invited because the previous step finished",
    forwarded: "{from} forwarded their turn to {to}",
    part_forwarded: "{from} forwarded the part {part} to {to}",
    part_taken_back: "{actor} took the part {part} back from {from}",
    signer_moved: "{actor} was moved to step {step}",
    forwarding_on: "{sender} allowed forwarding",
    forwarding_off: "{sender} switched forwarding off",
    envelope_sent: "This document was sent as part of document collection {reference} ({count} documents)",
    envelope_completed: "Every document of document collection {reference} was completed",
    envelope_declined: "{by} declined document collection {reference}",
    all_submitted: "Everyone had submitted",
    created_form: "{sender} created the form",
    sent_form: "{sender} sent the form",
    viewed_form: "{actor} opened the form",
    consented_form: "{actor} agreed to submit electronically",
    submitted_form: "{actor} submitted their details",
    declined_form: "{actor} declined to complete the form",
    sealed_form: "The submission record was sealed",
    completed_form: "The submission was recorded",
  },
  ms: {
    created: "{sender} mencipta dokumen",
    sent: "{sender} menghantar dokumen",
    invited: "{actor} dijemput",
    resent: "Pautan baharu dihantar kepada {actor}",
    reminded: "Peringatan dihantar kepada {actor}",
    recipient_changed: "Penerima {actor} ditukar",
    viewed: "{actor} membuka dokumen",
    code_sent: "Kod pengesahan dihantar kepada {actor}",
    code_verified: "{actor} memasukkan kod pengesahan",
    code_verified_halo: "{actor} dikenal pasti melalui log masuk Halo (kaedah pengesahan: log masuk Halo)",
    code_failed: "{actor} memasukkan kod pengesahan yang salah",
    consented: "{actor} bersetuju menandatangani secara elektronik",
    signed: "{actor} menandatangani",
    submitted: "{actor} melengkapkan bahagiannya",
    declined: "{actor} enggan menandatangani",
    all_signed: "Semua pihak telah menandatangani",
    sealed: "Dokumen dimeterai",
    completed: "Dokumen disempurnakan",
    voided: "{sender} membatalkan dokumen",
    expired: "Dokumen tamat tempoh",
    delivery_failed: "Mesej kepada {actor} tidak dapat dihantar",
    uploaded: "{actor} memuat naik {name} (cap jari {hash})",
    upload_removed: "{actor} mengalih keluar muat naik {name}",
    expiry_extended: "{sender} melanjutkan tarikh tamat tempoh kepada {date}",
    expiry_extended_plain: "{sender} melanjutkan tarikh tamat tempoh",
    invitedAfter: "{actor} dijemput kerana {name} telah selesai",
    invitedAfterStep: "{actor} dijemput kerana langkah sebelumnya telah selesai",
    forwarded: "{from} menyerahkan gilirannya kepada {to}",
    part_forwarded: "{from} menyerahkan bahagian {part} kepada {to}",
    part_taken_back: "{actor} mengambil semula bahagian {part} daripada {from}",
    signer_moved: "{actor} dipindahkan ke langkah {step}",
    forwarding_on: "{sender} membenarkan penyerahan kepada orang lain",
    forwarding_off: "{sender} menutup penyerahan kepada orang lain",
    envelope_sent: "Dokumen ini dihantar sebagai sebahagian daripada koleksi dokumen {reference} ({count} dokumen)",
    envelope_completed: "Semua dokumen dalam koleksi dokumen {reference} telah disempurnakan",
    envelope_declined: "{by} menolak koleksi dokumen {reference}",
    all_submitted: "Semua pihak telah menghantar",
    created_form: "{sender} mencipta borang",
    sent_form: "{sender} menghantar borang",
    viewed_form: "{actor} membuka borang",
    consented_form: "{actor} bersetuju menghantar secara elektronik",
    submitted_form: "{actor} menghantar butirannya",
    declined_form: "{actor} enggan melengkapkan borang",
    sealed_form: "Rekod penghantaran dimeterai",
    completed_form: "Penghantaran direkodkan",
  },
  zh: {
    created: "{sender} 创建了文件",
    sent: "{sender} 发送了文件",
    invited: "已邀请 {actor}",
    resent: "已向 {actor} 发送新链接",
    reminded: "已向 {actor} 发送提醒",
    recipient_changed: "收件人 {actor} 已更改",
    viewed: "{actor} 打开了文件",
    code_sent: "已向 {actor} 发送验证码",
    code_verified: "{actor} 输入了验证码",
    code_verified_halo: "{actor} 通过 Halo 登录完成身份确认（验证方式：Halo 登录）",
    code_failed: "{actor} 输入了错误的验证码",
    consented: "{actor} 同意以电子方式签署",
    signed: "{actor} 已签署",
    submitted: "{actor} 完成了其部分",
    declined: "{actor} 拒绝签署",
    all_signed: "所有人均已签署",
    sealed: "文件已封存",
    completed: "文件已完成",
    voided: "{sender} 取消了文件",
    expired: "文件已过期",
    delivery_failed: "发给 {actor} 的消息未能送达",
    uploaded: "{actor} 上传了 {name}（指纹 {hash}）",
    upload_removed: "{actor} 删除了上传的 {name}",
    expiry_extended: "{sender} 将截止日期延长至 {date}",
    expiry_extended_plain: "{sender} 延长了截止日期",
    invitedAfter: "因 {name} 已完成，已邀请 {actor}",
    invitedAfterStep: "因上一步骤已完成，已邀请 {actor}",
    forwarded: "{from} 将其环节转交给 {to}",
    part_forwarded: "{from} 将“{part}”部分转交给 {to}",
    part_taken_back: "{actor} 从 {from} 处收回了“{part}”部分",
    signer_moved: "{actor} 已移至第 {step} 步",
    forwarding_on: "{sender} 允许转交",
    forwarding_off: "{sender} 关闭了转交",
    envelope_sent: "本文件作为文件集 {reference}（共 {count} 份）的一部分发送",
    envelope_completed: "文件集 {reference} 中的所有文件均已完成",
    envelope_declined: "{by} 拒绝了文件集 {reference}",
    all_submitted: "所有人均已提交",
    created_form: "{sender} 创建了表格",
    sent_form: "{sender} 发送了表格",
    viewed_form: "{actor} 打开了表格",
    consented_form: "{actor} 同意以电子方式提交",
    submitted_form: "{actor} 提交了资料",
    declined_form: "{actor} 拒绝填写表格",
    sealed_form: "提交记录已封存",
    completed_form: "提交已记录",
  },
  ko: {
    created: "{sender}님이 문서를 만들었습니다",
    sent: "{sender}님이 문서를 발송했습니다",
    invited: "{actor}님을 초대했습니다",
    resent: "{actor}님에게 새 링크를 보냈습니다",
    reminded: "{actor}님에게 알림을 보냈습니다",
    recipient_changed: "수신자 {actor}님이 변경되었습니다",
    viewed: "{actor}님이 문서를 열었습니다",
    code_sent: "{actor}님에게 인증 코드를 보냈습니다",
    code_verified: "{actor}님이 인증 코드를 입력했습니다",
    code_verified_halo: "{actor}님이 Halo 로그인으로 본인 확인을 했습니다 (인증 방식: Halo 로그인)",
    code_failed: "{actor}님이 잘못된 인증 코드를 입력했습니다",
    consented: "{actor}님이 전자 서명에 동의했습니다",
    signed: "{actor}님이 서명했습니다",
    submitted: "{actor}님이 자신의 부분을 작성했습니다",
    declined: "{actor}님이 서명을 거부했습니다",
    all_signed: "모든 분이 서명을 마쳤습니다",
    sealed: "문서가 봉인되었습니다",
    completed: "문서가 완료되었습니다",
    voided: "{sender}님이 문서를 취소했습니다",
    expired: "문서가 만료되었습니다",
    delivery_failed: "{actor}님에게 보낸 메시지를 전달하지 못했습니다",
    uploaded: "{actor}님이 {name}을(를) 업로드했습니다 (지문 {hash})",
    upload_removed: "{actor}님이 업로드한 {name}을(를) 삭제했습니다",
    expiry_extended: "{sender}님이 만료일을 {date}(으)로 연장했습니다",
    expiry_extended_plain: "{sender}님이 만료일을 연장했습니다",
    invitedAfter: "{name}님이 마쳐서 {actor}님을 초대했습니다",
    invitedAfterStep: "이전 단계가 끝나서 {actor}님을 초대했습니다",
    forwarded: "{from}님이 자신의 차례를 {to}님에게 넘겼습니다",
    part_forwarded: "{from}님이 {part} 부분을 {to}님에게 넘겼습니다",
    part_taken_back: "{actor}님이 {part} 부분을 {from}님에게서 되찾았습니다",
    signer_moved: "{actor}님이 {step}단계로 옮겨졌습니다",
    forwarding_on: "{sender}님이 전달을 허용했습니다",
    forwarding_off: "{sender}님이 전달을 껐습니다",
    envelope_sent: "이 문서는 문서 모음 {reference}(문서 {count}건)의 일부로 발송되었습니다",
    envelope_completed: "문서 모음 {reference}의 모든 문서가 완료되었습니다",
    envelope_declined: "{by}님이 문서 모음 {reference}을(를) 거부했습니다",
    all_submitted: "모든 분이 제출을 마쳤습니다",
    created_form: "{sender}님이 양식을 만들었습니다",
    sent_form: "{sender}님이 양식을 발송했습니다",
    viewed_form: "{actor}님이 양식을 열었습니다",
    consented_form: "{actor}님이 전자 제출에 동의했습니다",
    submitted_form: "{actor}님이 정보를 제출했습니다",
    declined_form: "{actor}님이 양식 작성을 거부했습니다",
    sealed_form: "제출 기록이 봉인되었습니다",
    completed_form: "제출이 기록되었습니다",
  },
};

/**
 * Events that are noise on a certificate: retries and autosaves, a part's progress and the contact being updated
 * (the last carries personal data and belongs in the audit trail, not on a page that is sent to everyone).
 */
export const HIDDEN_EVENTS = new Set(["saved", "seal_attempt_failed", "seal_retried", "seal_failed", "downloaded", "part_completed", "part_reopened", "writeback", "halo_link", "sensitive_viewed", "file_replaced", "envelope_document_added", "envelope_document_removed", "envelope_reordered", "copy_recipient_added", "copy_recipient_removed", "cancelled", "cancel_notice_sent"]);

/** What an event's own detail adds to its sentence. */
export interface EventExtras {
  detail?: Record<string, unknown>;
  /** The time zone dates in a sentence are written in. */
  timeZone?: string;
  /** The title of a part of the document's form in the document's language (a forwarded part is named by it). */
  partTitle?: (partKey: string) => string;
  /** A form without a signature words several events as submitting, not signing (migration 169). */
  mode?: SignMode;
}

/** A short piece of text from an event's detail (fill() puts it on one line). */
const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/**
 * One line of history, or null for an event the certificate leaves out. An upload names the file and the start of
 * its fingerprint (the file itself is not appended: the certificate lists it); an extended expiry names the new date.
 */
export function eventSentence(type: string, locale: SignLocale, names: { actor: string; sender: string }, extras: EventExtras = {}): string | null {
  if (HIDDEN_EVENTS.has(type)) return null;
  const words = EVENTS[locale] ?? EVENTS.en;
  const detail = extras.detail ?? {};
  let key = type;
  const values: Record<string, string> = { ...names, name: text(detail.name, 80) || "-", hash: text(detail.hash, 16) || "-", date: "" };
  // forwarding and steps (migration 166): names only, the address is never on a certificate
  values.from = text(detail.from_name, 160) || names.actor || "-";
  values.to = text(detail.to_name, 160) || "-";
  values.step = typeof detail.to_step === "number" ? String(detail.to_step) : "-";
  // envelopes (migration 171): the envelope's reference, how many documents it holds, and who declined it
  values.reference = text(detail.reference, 40) || "-";
  values.count = typeof detail.count === "number" ? String(detail.count) : "-";
  values.by = text(detail.by_name, 160) || names.actor || "-";
  const partKey = text(detail.part, 80);
  values.part = partKey ? (extras.partTitle?.(partKey) ?? partKey) : "-";
  if (type === "invited") {
    const finished = text(detail.finished_name, 160);
    if (detail.because === "signer_finished" && finished) {
      key = "invitedAfter";
      values.name = finished;
    } else if (detail.because === "step_finished") key = "invitedAfterStep";
  } else if (type === "forwarding_changed") {
    key = detail.allow === false ? "forwarding_off" : "forwarding_on";
  }
  if (type === "expiry_extended") {
    const at = typeof detail.new === "string" ? new Date(detail.new) : null;
    if (at && !Number.isNaN(at.getTime())) values.date = longDate(at, locale, extras.timeZone);
    else key = "expiry_extended_plain";
  }
  // a Halo user who opened their own turn from inside Halo was identified by their sign-in, not by a code (service/countersign.ts)
  if (type === "code_verified" && detail.method === "halo_login") key = "code_verified_halo";
  // a form without a signature: "submitted their details", not "signed" (the `_form` variants, where there is one)
  if (extras.mode === "form" && (words[`${key}_form`] ?? EVENTS.en[`${key}_form`])) key = `${key}_form`;
  const template = words[key] ?? EVENTS.en[key];
  return template ? fill(template, values) : null;
}
