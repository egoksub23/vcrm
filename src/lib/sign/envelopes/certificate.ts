// ============================================================
// Envelopes (migration 171): the block "Part of document collection {reference}" on each document's certificate. It lists the documents signed
// together by title, reference and the SHA-256 of the file AS SENT: that fingerprint exists for every sibling from the moment the envelope
// is sent, so the block reads the same whichever document was sealed first. Pure; the page drawing is `appendCertificate`'s.
// ============================================================

import type { CertificateEnvelope } from "../pdf/types";
import type { SignLocale } from "../types";

interface Words {
  heading: string; // {reference} {number} {count}
  note: string; // {count}
  here: string;
  reference: string;
  sha256: string;
}

const EN: Words = {
  heading: "Part of document collection {reference} (document {number} of {count})",
  note: "This document was signed together with the documents below in one sitting. Each has its own certificate; the fingerprints are those of the files as they were sent.",
  here: "this document",
  reference: "Reference",
  sha256: "SHA-256 as sent",
};
const MS: Words = {
  heading: "Sebahagian daripada koleksi dokumen {reference} (dokumen {number} daripada {count})",
  note: "Dokumen ini ditandatangani bersama dokumen di bawah dalam satu sesi. Setiap satu mempunyai perakuannya sendiri; cap jari ialah cap jari fail seperti dihantar.",
  here: "dokumen ini",
  reference: "Rujukan",
  sha256: "SHA-256 seperti dihantar",
};
const ZH: Words = {
  heading: "属于文件集 {reference}（第 {number} 份，共 {count} 份）",
  note: "本文件与下列文件在同一次签署中一并签署。每份文件各有自己的证书；指纹为各文件发送时的指纹。",
  here: "本文件",
  reference: "编号",
  sha256: "发送时的 SHA-256",
};
const KO: Words = {
  heading: "문서 모음 {reference}에 포함됨 (문서 {count}건 중 {number}번째)",
  note: "이 문서는 아래 문서들과 한 번에 함께 서명되었습니다. 각 문서에는 자체 증명서가 있으며, 지문은 발송 당시 파일의 지문입니다.",
  here: "이 문서",
  reference: "문서 번호",
  sha256: "발송 시점의 SHA-256",
};

const DICT: Record<SignLocale, Words> = { en: EN, ms: MS, zh: ZH, ko: KO };

const fill = (template: string, values: Record<string, string | number>) => template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));

export interface EnvelopeSibling {
  id: string;
  title: string;
  reference: string | null;
  base_sha256: string | null;
  envelope_position?: number | null;
}

/**
 * The block for the certificate of `currentId`: the envelope's reference, this document's place, and every document of the envelope in
 * order with its title, reference and fingerprint. Null when the envelope has fewer than two documents to list.
 */
export function envelopeCertificateBlock(locale: SignLocale, envelope: { reference: string | null; id: string }, siblings: readonly EnvelopeSibling[], currentId: string): CertificateEnvelope | null {
  const docs = [...siblings].sort((a, b) => (a.envelope_position ?? 0) - (b.envelope_position ?? 0));
  if (docs.length < 2) return null;
  const w = DICT[locale] ?? EN;
  const at = Math.max(1, docs.findIndex((d) => d.id === currentId) + 1);
  return {
    heading: fill(w.heading, { reference: envelope.reference ?? envelope.id, number: at, count: docs.length }),
    note: fill(w.note, { count: docs.length }),
    referenceLabel: w.reference,
    sha256Label: w.sha256,
    hereLabel: w.here,
    documents: docs.map((d, i) => ({ number: i + 1, title: d.title, reference: d.reference ?? d.id, sha256: d.base_sha256 ?? "", current: d.id === currentId })),
  };
}
