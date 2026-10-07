// The Doc Sign PDF engine: plain TypeScript over bytes, no framework imports.
// Pipeline (docs/vircle-sign-plan.md, section 5):
//   freezeBase  -> the template with the sender's static and merge values; fingerprint it
//   stampFields -> the same file with what the signers entered
//   appendCertificate -> certificate pages inside the file (who, when, from where, fingerprints, QR); buildCertificate -> the same as a PDF of its own (migration 178)
//   buildSubmissionRecord -> the answer pages of a form without a signature (migration 169); the certificate pages go after them
//   sealPdf     -> a digital signature over the lot
//   verifySealed -> check a sealed file without trusting the code that sealed it
export * from "./types";
export { inspectPdf, openPdf, isPdf, sha256Hex, PdfError, PDF_ERROR_MESSAGES, MAX_PAGES, MAX_FILE_BYTES, type PdfErrorCode } from "./load";
export { freezeBase, stampFields, staticValues, answerFields } from "./stamp";
export { appendCertificate, buildCertificate, buildCollectionSummary, DEFAULT_CERTIFICATE_LABELS, type CertificateResult, type CertificateOptions } from "./certificate";
export { drawIdFooter, drawIdFooters, idFooterText, ID_FOOTER_BRAND, ID_FOOTER_SIZE, ID_FOOTER_LIFT, ID_FOOTER_MIN_SIZE } from "./idfooter";
export { buildSubmissionRecord, blankFormPage, DEFAULT_RECORD_LABELS, type RecordData, type RecordLabels } from "./record";
export { sealPdf, SealError, SIGNATURE_LENGTH } from "./seal";
export { markTestPages, placeCentred, TEST_MARK_TEXT, TEST_MARK_NOTE } from "./testmark";
export { verifySealed } from "./verify";
export { createSelfSignedP12, readP12, assertValidNow, CertificateError, type P12Facts } from "./p12";
export { formatDate, formatDateTime, formatIsoDate, formatNumber, fitText, wrapText, DEFAULT_DATE_FORMAT, type EngineLocale } from "./format";
export { shownBoxToUser, normalizeRotation, pageShownSize } from "./geometry";
