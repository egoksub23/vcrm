// ============================================================
// The names of a document's sealed files, in one place: the signed document (or, for a form without a signature, the sealed record) and its
// certificate (migration 178). The same names are on the download, in the zip, on the email attachment and in the standalone certificate's
// "signed document" line, so what a person receives is what the certificate names. Pure, safe on the client.
// ============================================================

import type { SignMode } from "./types";

type Named = { reference?: string | null; mode?: SignMode | null };

/** `SGN-2026-000123-signed.pdf` (a form without a signature: `-record.pdf`). */
export const signedFileName = (doc: Named): string => `${doc.reference ?? "document"}-${doc.mode === "form" ? "record" : "signed"}.pdf`;

/** `SGN-2026-000123-certificate.pdf`. */
export const certificateFileName = (doc: Named): string => `${doc.reference ?? "document"}-certificate.pdf`;
