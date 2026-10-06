// ============================================================
// GET /api/v1/sign/documents/{id}  — one document  (scope: sign:read)
//
// Status, each person with their status and signed_at, the timestamps, `final_sha256` and `verify_url` once
// completed, and `progress` per part for a document with a form (null otherwise). Never a link, token, code,
// IP address, device or form answer. A document of another workspace is a 404, the same as a missing one.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok } from '@/lib/api/v1/respond';
import { documentIdOf, serializeBundle, signApiError, signCtx } from '@/lib/api/v1/sign';
import { loadBundle, progressForApi } from '@/lib/sign/service/api';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const api = await requireApiKey(request, 'sign:read');
    const ctx = await signCtx(request, api);
    const bundle = await loadBundle(ctx, documentIdOf((await params).id));
    return ok(serializeBundle(bundle, ctx.origin, { progress: await progressForApi(ctx, bundle.document) }));
  } catch (err) {
    return signApiError(err);
  }
}
