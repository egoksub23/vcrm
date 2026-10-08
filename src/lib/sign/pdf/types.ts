// ============================================================
// Doc Sign PDF engine: shared types (docs/vircle-sign-plan.md, section 5).
//
// Plain TypeScript with no framework imports, so the engine can move to its
// own worker later without a rewrite. Everything takes and returns bytes.
// ============================================================

/** What a placed field collects or shows. */
export const FIELD_TYPES = [
  "signature",
  "initials",
  "name",
  "date_signed",
  "date",
  "text",
  "number",
  "static_text",
  "checkbox",
  "dropdown",
  "upload",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/**
 * A field placed on a page. Position and size are fractions of the page as it is shown
 * (0 to 1, origin top-left), so a field stays where it was put whatever the page size
 * or rotation is.
 */
export interface PlacedField {
  /** Unique within a document, for example "f_8k2x". */
  key: string;
  type: FieldType;
  /** The role (signer or filler) that completes it. Static fields use the sender's role. */
  role: string;
  /** 0-based page index. */
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  required: boolean;
  label?: string;
  /** dropdown */
  options?: string[];
  /** date / date_signed: tokens DD, MM, MMM, MMMM, YYYY, YY. Default "DD MMM YYYY". */
  dateFormat?: string;
  /** number: digits after the decimal point. */
  decimals?: number;
  multiline?: boolean;
  /** Fixed font size in points; otherwise the largest that fits. */
  fontSize?: number;
  align?: "left" | "center" | "right";
  /** static_text: the text. A merge field fills it from merge values instead. */
  text?: string;
  /** Key in the document's merge values that fills this field when the document is sent. */
  merge?: string;
  /**
   * Forms: the key of the data field whose answer this placement prints. A bound placement is not asked
   * of anyone; the answer to the form is drawn here when the document is sealed.
   */
  data?: string;
  /** A tick box bound to a choice: ticked when the answer is (or includes) this option. */
  dataValue?: string;
}

/** The value of one field, as entered or derived. Which members matter depends on the field type. */
export interface FieldValue {
  text?: string;
  checked?: boolean;
  /** signature / initials drawn or uploaded, or an uploaded image */
  image?: { bytes: Uint8Array; mime: "image/png" | "image/jpeg" };
  /** signature / initials typed: drawn in a script font */
  typed?: string;
  /** date_signed: when it was signed */
  at?: Date;
}

export type FieldValues = Readonly<Record<string, FieldValue>>;

export interface PageInfo {
  /** Visible size in points (after /Rotate). */
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
}

export interface PdfInfo {
  pageCount: number;
  pages: PageInfo[];
}

export interface StampOptions {
  /** Language for month names in dates. */
  locale?: "en" | "ms" | "zh" | "ko";
  /** Time zone for dates written by the engine (date_signed). Default UTC. */
  timeZone?: string;
  /**
   * The line stamped on every page, in the bottom margin (see idfooter.ts): only the sealing step asks for it, so a draft, a preview and a document being
   * signed never carry it. The stamp can never fail the call: a page it cannot be put on is counted in `footer` and left as it was.
   */
  idFooter?: string;
}

/** What a footer stamp did: pages stamped, pages it was left off (too small to hold it), pages it could not be drawn on. */
export interface FooterResult {
  stamped: number;
  skipped: number;
  failed: number;
}

export interface StampResult {
  bytes: Uint8Array;
  /** Fields that could not be drawn as given (unsupported characters, a value too long for its box). */
  warnings: StampWarning[];
  /** Present when `idFooter` was asked for. */
  footer?: FooterResult;
}

export interface StampWarning {
  field: string;
  code: "unsupported_characters" | "text_truncated" | "missing_page" | "bad_image";
  detail?: string;
}

export interface CertificateSigner {
  name: string;
  email: string;
  role: string;
  /** Ordinal, shown only when the document needed signing order. */
  order?: number;
  status: "signed" | "declined" | "pending";
  signedAt?: Date;
  ip?: string;
  device?: string;
  /** Email, WhatsApp. */
  channel?: string;
}

export interface CertificateEvent {
  at: Date;
  /** Already worded for the reader, for example "Ali bin Ahmad opened the document". */
  text: string;
}

/**
 * Migration 171: the document is one of an envelope signed in one sitting. An optional block of the certificate (its own drawing function,
 * `envelopeBlock` in certificate.ts): the envelope and the documents in it with their fingerprints as sent. Every word is already in the
 * document's language.
 */
export interface CertificateEnvelope {
  /** "Part of document collection COL-2026-000012 (document 2 of 3)" (a collection made before migration 176 has an ENV- reference; both are shown as stored). */
  heading: string;
  note: string;
  referenceLabel: string;
  sha256Label: string;
  /** Marks the document the certificate is of, in the list. */
  hereLabel: string;
  documents: { number: number; title: string; reference: string; sha256: string; current: boolean }[];
}

/**
 * The signed file a standalone certificate (migration 178) is about: its name and the fingerprint that identifies it. The certificate is
 * made after the signed file is sealed, so it can name it; a certificate that is embedded in the signed file cannot, and has none of this.
 */
export interface CertificateCovers {
  fileName: string;
  /** SHA-256 of the sealed file the certificate covers. */
  sha256: string;
}

export interface CertificateData {
  title: string;
  reference: string;
  /** The document's id, the one in the address of its verify page and in the footer stamped on every page of the signed file. */
  documentId?: string;
  /** A standalone certificate: the signed file it covers. Absent for the certificate pages embedded in the signed file. */
  covers?: CertificateCovers;
  workspaceName: string;
  /** SHA-256 of the file as sent (before anything was written on it). */
  baseSha256: string;
  /** Number of pages in the signed document, before these pages are added. */
  pageCount: number;
  signers: CertificateSigner[];
  events: CertificateEvent[];
  /** The audit chain's last hash at the moment of sealing. */
  chainHead: string;
  /** Where anyone can check this document, shown as text and as a QR code. */
  verifyUrl: string;
  sentAt?: Date;
  completedAt: Date;
  /** Words around the table. Defaults are in English. */
  labels?: Partial<CertificateLabels>;
  timeZone?: string;
  /** Migration 171: present when the document is part of an envelope. */
  envelope?: CertificateEnvelope;
}

export interface CertificateLabels {
  heading: string;
  reference: string;
  document: string;
  pages: string;
  sentOn: string;
  completedOn: string;
  fingerprint: string;
  signers: string;
  name: string;
  email: string;
  role: string;
  status: string;
  signedOn: string;
  ip: string;
  device: string;
  channel: string;
  history: string;
  chainHead: string;
  verify: string;
  statusSigned: string;
  statusDeclined: string;
  statusPending: string;
  note: string;
  page: string;
  of: string;
  /** The document's id (shown beside its reference). */
  documentId: string;
  /** A standalone certificate: the name of the file it covers, and that file's fingerprint. */
  signedFile: string;
  signedFingerprint: string;
  /** What closes a standalone certificate in place of `note`. */
  standaloneNote: string;
}

/** The words of the collection summary, already in the collection's language (collection-summary-words.ts). */
export interface CollectionSummaryLabels {
  heading: string;
  reference: string;
  title: string;
  documents: string;
  preparedOn: string;
  documentsHeading: string;
  documentReference: string;
  file: string;
  fingerprint: string;
  certificateFile: string;
  certificateFingerprint: string;
  certificateEmbedded: string;
  signedBy: string;
  nobody: string;
  note: string;
  page: string;
  of: string;
  /** Migration 181: the line for a collection that was cancelled afterwards ("Cancelled" and its date), and a sentence saying what that means for the files. */
  cancelled: string;
  cancelledNote: string;
}

/** One document of a collection on its summary. */
export interface CollectionSummaryDocument {
  number: number;
  title: string;
  reference: string;
  /** The name of its signed file in the zip, and that file's SHA-256. */
  fileName: string;
  sha256: string;
  /** The name of its standalone certificate in the zip and the certificate's SHA-256; absent when the certificate is embedded in the signed file. */
  certificateFileName?: string;
  certificateSha256?: string;
  signers: { name: string; signedAt?: Date }[];
}

/** The small PDF that opens a collection's zip: the collection, and each document with its fingerprint and who signed. */
export interface CollectionSummaryData {
  reference: string;
  title: string;
  workspaceName: string;
  preparedAt: Date;
  timeZone?: string;
  documents: CollectionSummaryDocument[];
  /** Migration 181: when the (completed) collection was cancelled. The signed files in the zip are exactly as they were; the summary, which is not sealed, says so. */
  cancelledAt?: Date;
  labels: CollectionSummaryLabels;
}

export interface SealOptions {
  reason?: string;
  location?: string;
  /** The signer's displayed name inside the signature dictionary. */
  name?: string;
  contactInfo?: string;
  /** Signing time written into the signature. Default: now. */
  signingTime?: Date;
}

export interface SealedInfo {
  /** SHA-256 of the complete sealed file. */
  sha256: string;
  size: number;
}

export interface VerifyResult {
  /** The file carries exactly one signature and every check below passed. */
  ok: boolean;
  signatureCount: number;
  /** The PKCS#7 signature verifies against the certificate inside it. */
  signatureValid: boolean;
  /** The signed byte ranges hash to the digest the signature carries. */
  digestMatches: boolean;
  /** The signed ranges cover the whole file except the signature value itself. */
  coversWholeFile: boolean;
  signer?: {
    subject: string;
    issuer: string;
    notBefore: Date;
    notAfter: Date;
    selfSigned: boolean;
  };
  /** How many certificates the signature carries: the signer's, then any that vouch for it (the chain a reader builds from). */
  certificateCount?: number;
  signingTime?: Date;
  reason?: string;
  sha256: string;
  problems: string[];
}
