// ============================================================
// The words of the "Collection summary" PDF that opens the zip of a document collection (migration 178), in the collection's language. Pure.
// A collection of forms without a signature says "submitted" and "record" where a collection of agreements says "signed" and "signed document".
// ============================================================

import type { CollectionSummaryLabels } from "./pdf/types";
import type { SignLocale, SignMode } from "./types";

const EN: CollectionSummaryLabels = {
  heading: "Collection summary",
  reference: "Collection reference",
  title: "Collection",
  documents: "Documents",
  preparedOn: "Prepared",
  documentsHeading: "Documents in this collection",
  documentReference: "Document reference",
  file: "Signed document file",
  fingerprint: "SHA-256 of the signed document",
  certificateFile: "Certificate file",
  certificateFingerprint: "SHA-256 of the certificate",
  certificateEmbedded: "The certificate pages are inside the signed document",
  signedBy: "Signed by",
  nobody: "No signatures are listed",
  note: "This summary is an index to the other files in this download. It is not sealed: each certificate is, and each certificate names the signed document it covers by its SHA-256 fingerprint. To check a file, open the verification page of its document.",
  page: "Page",
  of: "of",
  cancelled: "Cancelled",
  cancelledNote: "This collection was cancelled after it was signed. The signed documents in this download are exactly as they were signed and remain a record of what was signed; they are no longer in force.",
};

const MS: CollectionSummaryLabels = {
  heading: "Ringkasan koleksi",
  reference: "Rujukan koleksi",
  title: "Koleksi",
  documents: "Dokumen",
  preparedOn: "Disediakan",
  documentsHeading: "Dokumen dalam koleksi ini",
  documentReference: "Rujukan dokumen",
  file: "Fail dokumen bertandatangan",
  fingerprint: "SHA-256 dokumen bertandatangan",
  certificateFile: "Fail sijil",
  certificateFingerprint: "SHA-256 sijil",
  certificateEmbedded: "Halaman sijil berada di dalam dokumen bertandatangan",
  signedBy: "Ditandatangani oleh",
  nobody: "Tiada tandatangan disenaraikan",
  note: "Ringkasan ini ialah indeks kepada fail lain dalam muat turun ini. Ia tidak dimeterai: setiap sijil dimeterai, dan setiap sijil menamakan dokumen bertandatangan yang diliputinya melalui cap jari SHA-256. Untuk menyemak sesuatu fail, buka halaman pengesahan dokumennya.",
  page: "Halaman",
  of: "daripada",
  cancelled: "Dibatalkan",
  cancelledNote: "Koleksi ini dibatalkan selepas ia ditandatangani. Dokumen bertandatangan dalam muat turun ini kekal seperti semasa ditandatangani dan menjadi rekod apa yang ditandatangani; ia tidak lagi berkuat kuasa.",
};

const ZH: CollectionSummaryLabels = {
  heading: "文件集摘要",
  reference: "文件集编号",
  title: "文件集",
  documents: "文件数",
  preparedOn: "编制时间",
  documentsHeading: "本文件集中的文件",
  documentReference: "文件编号",
  file: "已签署文件",
  fingerprint: "已签署文件的 SHA-256",
  certificateFile: "证书文件",
  certificateFingerprint: "证书的 SHA-256",
  certificateEmbedded: "证书页包含在已签署文件之内",
  signedBy: "签署人",
  nobody: "没有列出签署",
  note: "本摘要是此次下载中其他文件的索引。它本身未封存：每份证书都已封存，并以 SHA-256 指纹指明其涵盖的已签署文件。要核验某个文件，请打开其所属文件的核验页面。",
  page: "页",
  of: "共",
  cancelled: "取消时间",
  cancelledNote: "本文件集在签署之后被取消。此次下载中的已签署文件与签署时完全一致，仍是已签署内容的记录，但已不再有效。",
};

const KO: CollectionSummaryLabels = {
  heading: "문서 모음 요약",
  reference: "문서 모음 번호",
  title: "문서 모음",
  documents: "문서 수",
  preparedOn: "작성",
  documentsHeading: "이 문서 모음에 포함된 문서",
  documentReference: "문서 번호",
  file: "서명된 문서 파일",
  fingerprint: "서명된 문서의 SHA-256",
  certificateFile: "증명서 파일",
  certificateFingerprint: "증명서의 SHA-256",
  certificateEmbedded: "증명서 페이지는 서명된 문서 안에 들어 있습니다",
  signedBy: "서명자",
  nobody: "기재된 서명이 없습니다",
  note: "이 요약은 이번 다운로드의 다른 파일에 대한 색인입니다. 봉인되어 있지 않으며, 각 증명서가 봉인되어 있고 각 증명서는 대상이 되는 서명된 문서를 SHA-256 지문으로 밝힙니다. 파일을 확인하려면 해당 문서의 확인 페이지를 여세요.",
  page: "페이지",
  of: "/",
  cancelled: "취소일",
  cancelledNote: "이 문서 모음은 서명된 후 취소되었습니다. 이번 다운로드의 서명된 문서는 서명 당시 그대로이며 서명된 내용의 기록으로 남지만, 더 이상 효력이 없습니다.",
};

const LABELS: Record<SignLocale, CollectionSummaryLabels> = { en: EN, ms: MS, zh: ZH, ko: KO };

const FORM: Record<SignLocale, Partial<CollectionSummaryLabels>> = {
  en: { file: "Record file", fingerprint: "SHA-256 of the sealed record", certificateEmbedded: "The certificate pages are inside the sealed record", signedBy: "Submitted by", nobody: "No submissions are listed" },
  ms: { file: "Fail rekod", fingerprint: "SHA-256 rekod termeterai", certificateEmbedded: "Halaman sijil berada di dalam rekod termeterai", signedBy: "Dihantar oleh", nobody: "Tiada penghantaran disenaraikan" },
  zh: { file: "记录文件", fingerprint: "封存记录的 SHA-256", certificateEmbedded: "证书页包含在封存记录之内", signedBy: "提交人", nobody: "没有列出提交" },
  ko: { file: "기록 파일", fingerprint: "봉인된 기록의 SHA-256", certificateEmbedded: "증명서 페이지는 봉인된 기록 안에 들어 있습니다", signedBy: "제출자", nobody: "기재된 제출이 없습니다" },
};

export function collectionSummaryLabels(locale: SignLocale, mode: SignMode = "sign"): CollectionSummaryLabels {
  const base = LABELS[locale] ?? EN;
  return mode === "form" ? { ...base, ...(FORM[locale] ?? FORM.en) } : base;
}

/** The name of the summary inside the zip. */
export const COLLECTION_SUMMARY_FILE = "Collection summary.pdf";
