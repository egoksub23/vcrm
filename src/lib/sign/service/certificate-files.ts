// ============================================================
// A document's certificate when it is a file of its own (migration 178): which of its files it is, and reading it. A document sealed before the
// migration has none (`certificate_path` is NULL): its certificate is inside the signed PDF, and everything here answers "no file".
// ============================================================

import { certificateFileName } from "../file-names";
import type { MailFile } from "../notify";
import { belongsToAccount, getFile } from "../storage";
import type { SignDocumentRow } from "../types";
import type { SignCtx } from "./context";

/** The document's certificate is a file of its own. */
export const hasOwnCertificate = (doc: Pick<SignDocumentRow, "certificate_path">): boolean => !!doc.certificate_path;

/**
 * The bytes of the document's own certificate file for an email, named for the document, or null when it has none or it cannot be read (a message is
 * still worth sending without it: the failure is logged, never thrown).
 */
export async function certificateOf(ctx: SignCtx, doc: Pick<SignDocumentRow, "id" | "reference" | "mode" | "certificate_path">): Promise<MailFile | null> {
  if (!doc.certificate_path || !belongsToAccount(doc.certificate_path, ctx.accountId)) return null;
  try {
    return { bytes: await getFile(ctx.admin, doc.certificate_path, ctx.accountId), filename: certificateFileName(doc) };
  } catch (err) {
    console.error("[sign] could not read the certificate file of", doc.id, err instanceof Error ? err.message : err);
    return null;
  }
}
