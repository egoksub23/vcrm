// ============================================================
// POST /api/v1/sign/documents/{id}/remind  — remind the people who have not finished  (scope: sign:write)
//
// Body `{ "signer_id": "..." }` for one person, or empty for everyone who is waiting. A person who was
// reminded less than 24 hours ago is not reminded again: 409 `remind_too_soon` for one person, listed under
// `held` when reminding everyone. Each reminder carries a fresh link and the earlier one stops working, as
// for a reminder from the screen. The answer says whether each message was delivered, never the link.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok } from '@/lib/api/v1/respond';
import { documentIdOf, isUuid, limitSends, readApiJson, signApiError, signCtx } from '@/lib/api/v1/sign';
import { remindForApi } from '@/lib/sign/service/api';
import { SignError } from '@/lib/sign/service/errors';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const api = await requireApiKey(request, 'sign:write');
    const ctx = await signCtx(request, api);
    limitSends(api);
    const id = documentIdOf((await params).id);
    const body = await readApiJson(request, 20_000);
    let signerId: string | null = null;
    if (body.signer_id !== undefined && body.signer_id !== null) {
      if (!isUuid(body.signer_id)) throw new SignError('bad_request', 'Some fields are not valid. See `issues`.', 400, [{ code: 'invalid', field: 'signer_id', detail: 'must be a signer id' }]);
      signerId = body.signer_id;
    }
    const out = await remindForApi(ctx, id, signerId);
    return ok({
      invitations: out.invitations.map((i) => ({ signer_id: i.signerId, role_key: i.roleKey, channel: i.channel, status: i.status })),
      held: out.held.map((h) => ({ signer_id: h.signerId, retry_at: h.retryAt })),
    });
  } catch (err) {
    return signApiError(err);
  }
}
