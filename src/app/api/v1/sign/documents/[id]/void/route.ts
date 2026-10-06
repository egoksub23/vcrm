// ============================================================
// POST /api/v1/sign/documents/{id}/void  — cancel a document  (scope: sign:write)
//
// Body `{ "reason": "..." }` (required, kept in the audit trail). Every link then shows that the document
// was cancelled and the people who were waiting are told. Cancelling a document that is already cancelled
// answers 200 with it as it is; one that completed, expired or was declined is a 409 `document_not_open`.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok } from '@/lib/api/v1/respond';
import { documentIdOf, readApiJson, serializeBundle, signApiError, signCtx } from '@/lib/api/v1/sign';
import { voidForApi } from '@/lib/sign/service/api';
import { SignError } from '@/lib/sign/service/errors';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const api = await requireApiKey(request, 'sign:write');
    const ctx = await signCtx(request, api);
    const id = documentIdOf((await params).id);
    const body = await readApiJson(request, 20_000);
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 1000) : '';
    if (!reason) throw new SignError('reason_required', "Say why this document is being cancelled in 'reason'.", 400);
    return ok(serializeBundle(await voidForApi(ctx, id, reason), ctx.origin));
  } catch (err) {
    return signApiError(err);
  }
}
