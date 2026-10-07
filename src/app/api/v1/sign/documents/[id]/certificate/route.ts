// ============================================================
// GET /api/v1/sign/documents/{id}/certificate  — the certificate of completion as a PDF  (scope: sign:read)
//
// The certificate of a completed document, as a file of its own (migration 178): who signed and when, the event timeline, the document's
// reference and id, a QR code to the verify page, and the SHA-256 of the signed file it covers. It is sealed with the same digital signature
// as the signed file. The bytes come as an attachment (never an address) with `X-Content-SHA256`, the certificate's own fingerprint (the same as
// `certificate_sha256` on the document). Every download is authenticated and recorded.
//
//   409 not_completed               the document is not completed yet
//   404 no_separate_certificate     the document was sealed before certificates became separate files: its certificate is the last pages of
//                                   the signed PDF (GET .../file?kind=signed)
// It is the same answer as GET .../file?kind=certificate.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { documentIdOf, fileResponse, signApiError, signCtx } from '@/lib/api/v1/sign';
import { fileForApi } from '@/lib/sign/service/api';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const api = await requireApiKey(request, 'sign:read');
    const ctx = await signCtx(request, api);
    const id = documentIdOf((await params).id);
    return fileResponse(await fileForApi(ctx, id, 'certificate'));
  } catch (err) {
    return signApiError(err);
  }
}
