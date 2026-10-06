// ============================================================
// Sealing: a PKCS#7 (adbe.pkcs7.detached) signature over the whole file, so any change made after
// sealing is reported by a PDF reader. The signature placeholder is added with pdf-lib, then
// @signpdf fills it. The certificate comes from the workspace's settings (see p12.ts).
// ============================================================

import signpdf from "@signpdf/signpdf";
import { P12Signer } from "@signpdf/signer-p12";
import { pdflibAddPlaceholder } from "@signpdf/placeholder-pdf-lib";

import { assertValidNow, readP12 } from "./p12";
import { MAX_PAGES, SEAL_EXTRA_PAGES, openPdf, savePdf, sha256Hex } from "./load";
import type { SealOptions, SealedInfo } from "./types";

/** Room for the signature (hex characters are two per byte). A certificate chain of a few links fits. */
export const SIGNATURE_LENGTH = 16384;

export class SealError extends Error {
  readonly code: "seal_failed" | "seal_too_large";
  constructor(code: SealError["code"], message: string) {
    super(message);
    this.name = "SealError";
    this.code = code;
  }
}

/** Seal `input` with the PKCS#12 certificate. Returns the sealed file. */
export async function sealPdf(
  input: Uint8Array,
  p12: Uint8Array,
  passphrase: string,
  options: SealOptions = {},
): Promise<{ bytes: Uint8Array } & SealedInfo> {
  // Refuse early, with a clear message, rather than fail inside the signing library.
  assertValidNow(readP12(p12, passphrase), options.signingTime ?? new Date());

  // the file here already has its certificate pages: it may be longer than a file that is accepted
  const doc = await openPdf(input, { maxPages: MAX_PAGES + SEAL_EXTRA_PAGES });
  const signingTime = options.signingTime ?? new Date();
  pdflibAddPlaceholder({
    pdfDoc: doc,
    reason: options.reason ?? "Sealed by Halo Doc Sign",
    contactInfo: options.contactInfo ?? "",
    name: options.name ?? "Halo Doc Sign",
    location: options.location ?? "",
    signingTime,
    signatureLength: SIGNATURE_LENGTH,
  });
  const withPlaceholder = await savePdf(doc);

  let signed: Buffer;
  try {
    signed = await signpdf.sign(Buffer.from(withPlaceholder), new P12Signer(Buffer.from(p12), { passphrase }), signingTime);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/signature.*(long|exceed|larger)|bigger|too\s+large/i.test(msg)) {
      throw new SealError("seal_too_large", "The certificate chain is too long to fit in the signature.");
    }
    throw new SealError("seal_failed", `Sealing failed: ${msg}`);
  }
  const bytes = new Uint8Array(signed);
  return { bytes, sha256: sha256Hex(bytes), size: bytes.byteLength };
}
