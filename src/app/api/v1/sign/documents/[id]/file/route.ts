// ============================================================
// GET /api/v1/sign/documents/{id}/file?kind=signed|certificate|original  — a file  (scope: sign:read)
//
// The bytes of the file, as an attachment (not a link: nothing about the file's address is handed out, and
// every download is authenticated and recorded). `signed` is the sealed PDF and exists only once the
// document is completed: any other state is a 409 `not_completed`. `certificate` is the certificate of completion
// as a PDF of its own (the same file as GET .../certificate) for a document sealed from migration 178 on; an older
// document has its certificate as the last pages of the signed copy, and `certificate` answers 404
// `no_separate_certificate` and points to `signed`. `original` is the file as uploaded, when
// the document has one. The response carries `X-Content-SHA256`, the file's fingerprint.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { documentIdOf, fileResponse, signApiError, signCtx } from '@/lib/api/v1/sign';
import { FILE_KINDS, fileForApi, type ApiFileKind } from '@/lib/sign/service/api';
import { SignError } from '@/lib/sign/service/errors';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const api = await requireApiKey(request, 'sign:read');
    const ctx = await signCtx(request, api);
    const id = documentIdOf((await params).id);
    const kind = new URL(request.url).searchParams.get('kind') ?? 'signed';
    if (!(FILE_KINDS as readonly string[]).includes(kind)) {
      throw new SignError('bad_request', 'Some filters are not valid. See `issues`.', 400, [{ code: 'invalid', field: 'kind', detail: `must be one of ${FILE_KINDS.join(', ')}` }]);
    }
    return fileResponse(await fileForApi(ctx, id, kind as ApiFileKind));
  } catch (err) {
    return signApiError(err);
  }
}
