// ============================================================
// The words on the answer pages of a submission record (a form without a signature, migration 169), in the document's
// language. The certificate pages that follow have their own words (certificate-words.ts). Pure.
// ============================================================

import { DEFAULT_RECORD_LABELS, type RecordLabels } from "./pdf/record";
import type { SignLocale } from "./types";

const MS: RecordLabels = {
  heading: "Rekod Penghantaran",
  reference: "Rujukan",
  workspace: "Ruang kerja",
  submittedBy: "Dihantar oleh",
  submittedOn: "Dihantar",
  language: "Bahasa",
  chainHead: "Cap jari jejak audit",
  answers: "Jawapan",
  part: "Bahagian",
  notAnswered: "Tidak dijawab",
  masked: "dipaparkan bertopeng",
  picture: "Satu gambar dilampirkan",
  filesTitle: "Fail yang dihantar",
  fileSha: "SHA-256",
  fileSize: "Saiz",
  sensitiveNote: "Jawapan yang ditandakan sensitif dipaparkan bertopeng. Ia disimpan dengan penyulitan dan bukan sebahagian daripada rekod ini.",
  page: "Halaman rekod",
  of: "daripada",
};

const ZH: RecordLabels = {
  heading: "提交记录",
  reference: "编号",
  workspace: "工作区",
  submittedBy: "提交人",
  submittedOn: "提交时间",
  language: "语言",
  chainHead: "审计记录指纹",
  answers: "答复",
  part: "部分",
  notAnswered: "未填写",
  masked: "已遮盖显示",
  picture: "已附上一张图片",
  filesTitle: "已提交的文件",
  fileSha: "SHA-256",
  fileSize: "大小",
  sensitiveNote: "标为敏感的答复以遮盖形式显示。它们加密保存，不属于本记录的内容。",
  page: "记录页",
  of: "共",
};

const KO: RecordLabels = {
  heading: "제출 기록",
  reference: "문서 번호",
  workspace: "워크스페이스",
  submittedBy: "제출자",
  submittedOn: "제출 일시",
  language: "언어",
  chainHead: "감사 기록 지문",
  answers: "답변",
  part: "부분",
  notAnswered: "답변 없음",
  masked: "가려서 표시",
  picture: "그림이 첨부되었습니다",
  filesTitle: "제출된 파일",
  fileSha: "SHA-256",
  fileSize: "크기",
  sensitiveNote: "민감 정보로 표시된 답변은 가려서 표시됩니다. 해당 답변은 암호화되어 보관되며 이 기록에 포함되지 않습니다.",
  page: "기록 페이지",
  of: "/",
};

const LABELS: Record<SignLocale, RecordLabels> = { en: DEFAULT_RECORD_LABELS, ms: MS, zh: ZH, ko: KO };

export const recordLabels = (locale: SignLocale): RecordLabels => LABELS[locale] ?? DEFAULT_RECORD_LABELS;

/** The document's language as it is named to its own readers. */
export const LANGUAGE_NAMES: Record<SignLocale, string> = { en: "English", ms: "Bahasa Melayu", zh: "中文", ko: "한국어" };
