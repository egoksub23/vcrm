// ============================================================
// POST /api/v1/sign/documents/{id}/send  — send a draft  (scope: sign:write)
//
// For a document made with `send: false`. The file is frozen with the values given, the document moves to
// "sent" and the first people are invited. The monthly limit of the workspace applies (429
// `sign_limit_reached`). A document that was already sent is a 409 `document_not_draft`.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok } from '@/lib/api/v1/respond';
import { documentIdOf, limitSends, serializeBundle, signApiError, signCtx } from '@/lib/api/v1/sign';
import { sendDraftForApi } from '@/lib/sign/service/api';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const api = await requireApiKey(request, 'sign:write');
    const ctx = await signCtx(request, api);
    limitSends(api);
    const out = await sendDraftForApi(ctx, documentIdOf((await params).id));
    return ok(serializeBundle(out, ctx.origin, { invitations: out.invitations }));
  } catch (err) {
    return signApiError(err);
  }
}
