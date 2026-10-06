// ============================================================
// The words on the certificate pages of a signed document, in the document's language: the labels,
// and one sentence for each kind of event in the history. Pure.
// ============================================================

import { DEFAULT_CERTIFICATE_LABELS } from "./pdf/certificate";
import type { CertificateLabels } from "./pdf/types";
import { fill } from "./messages";
import type { SignLocale } from "./types";

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
};

const LABELS: Record<SignLocale, CertificateLabels> = { en: DEFAULT_CERTIFICATE_LABELS, ms: MS, zh: ZH, ko: KO };

export function certificateLabels(locale: SignLocale): CertificateLabels {
  return LABELS[locale] ?? DEFAULT_CERTIFICATE_LABELS;
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
  },
};

/** Events that are noise on a certificate: retries and autosaves. */
export const HIDDEN_EVENTS = new Set(["saved", "seal_attempt_failed", "seal_failed", "downloaded"]);

/** One line of history, or null for an event the certificate leaves out. */
export function eventSentence(type: string, locale: SignLocale, names: { actor: string; sender: string }): string | null {
  if (HIDDEN_EVENTS.has(type)) return null;
  const words = EVENTS[locale] ?? EVENTS.en;
  const template = words[type] ?? EVENTS.en[type];
  return template ? fill(template, names) : null;
}
