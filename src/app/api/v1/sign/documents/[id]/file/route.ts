// ============================================================
// GET /api/v1/sign/documents/{id}/file?kind=signed|certificate|original  — a file  (scope: sign:read)
//
// The bytes of the file, as an attachment (not a link: nothing about the file's address is handed out, and
// every download is authenticated and recorded). `signed` is the sealed PDF and exists only once the
// document is completed: any other state is a 409 `not_completed`. The certificate is the last pages of the
// signed copy, so `certificate` answers 404 and points to `signed`. `original` is the file as uploaded, when
// the document has one. The response carries `X-Content-SHA256`, the file's fingerprint.
// ============================================================

import { NextResponse } from 'next/server';

import { requireApiKey } from '@/lib/auth/api-context';
import { documentIdOf, signApiError, signCtx } from '@/lib/api/v1/sign';
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
    const file = await fileForApi(ctx, id, kind as ApiFileKind);
    return new NextResponse(Buffer.from(file.bytes), {
      status: 200,
      headers: {
        'Content-Type': file.mime,
        'Content-Length': String(file.bytes.byteLength),
        'Content-Disposition': `attachment; filename="${file.filename.replace(/["\r\n]/g, '')}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        ...(file.sha256 ? { 'X-Content-SHA256': file.sha256 } : {}),
      },
    });
  } catch (err) {
    return signApiError(err);
  }
}
