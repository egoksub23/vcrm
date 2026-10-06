// ============================================================
// The sealing certificate on the Settings screen: what the server describes (never the key), and the small pure
// helpers the screen uses to word it. No I/O, and nothing here imports a Node module, so it is safe in a
// client component.
// ============================================================

export type CertificateWarningCode = "chain_missing" | "weak_signature_algorithm" | "chain_certificate_expired" | "not_for_document_signing";

export interface CertificateView {
  id: string;
  name: string;
  /** Uploaded by the workspace (false: made by Halo, self-signed). */
  uploaded: boolean;
  subject: string | null;
  issuer: string | null;
  /** Hexadecimal, as other tools show it. */
  serial: string | null;
  validFrom: string | null;
  validUntil: string | null;
  /** The certificate names itself as its own issuer. */
  selfSigned: boolean;
  /** SHA-256 of the certificate, lowercase hexadecimal. */
  fingerprint: string | null;
  /** Certificates the signature carries: this one and the authorities above it. */
  chainLength: number | null;
  keyBits: number | null;
  warnings: CertificateWarningCode[];
  /** False when the stored file could not be opened (the other facts then come from what was recorded). */
  readable: boolean;
}

/** Where a certificate comes from, which decides what a PDF reader says about it. */
export type CertificateKind = "generated" | "uploadedSelfSigned" | "authority";

export function certificateKind(c: Pick<CertificateView, "uploaded" | "selfSigned">): CertificateKind {
  if (!c.uploaded) return "generated";
  return c.selfSigned ? "uploadedSelfSigned" : "authority";
}

/** A serial number short enough to read: the last 16 hexadecimal digits, with a mark when it was cut. */
export function shortSerial(serial: string | null | undefined): string | null {
  if (!serial) return null;
  const s = serial.toUpperCase();
  return s.length > 16 ? `…${s.slice(-16)}` : s;
}

/** A fingerprint the way browsers and PDF readers print it: pairs of capitals separated by colons. */
export function groupFingerprint(hex: string | null | undefined): string | null {
  if (!hex) return null;
  return (hex.toUpperCase().match(/.{1,2}/g) ?? []).join(":");
}

/** The codes the certificate routes answer with that the certificate screen words itself. */
export const CERTIFICATE_ERROR_CODES = [
  "p12_unreadable",
  "p12_bad_passphrase",
  "p12_no_key",
  "p12_expired",
  "p12_not_yet_valid",
  "p12_key_too_small",
  "p12_unsupported_algorithm",
  "p12_key_usage",
  "p12_key_mismatch",
  "p12_chain_invalid",
  "certificate_file_too_large",
  "certificate_chain_too_large",
  "certificate_self_test_failed",
  "certificate_not_found",
  "no_file",
] as const;

const KNOWN: ReadonlySet<string> = new Set(CERTIFICATE_ERROR_CODES);

/** The message key under `Sign.admin.certificate` for a failure code, or null for one the screen has no own wording for. */
export function certificateErrorKey(code: string | null | undefined): string | null {
  return code && KNOWN.has(code) ? `errors.${code}` : null;
}

/** The warnings in the order shown, each once. */
export const CERTIFICATE_WARNING_CODES: readonly CertificateWarningCode[] = ["chain_missing", "weak_signature_algorithm", "chain_certificate_expired", "not_for_document_signing"];
