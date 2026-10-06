// ============================================================
// GET /api/v1/sign/templates  — the templates a document can be made from (scope: sign:read)
//
// Active templates of the key's workspace, each with the roles to name in `signers[].role_key`, the merge
// keys to fill in `merge_values`, and whether it carries a form. 403 `sign_disabled` when Doc Sign is off
// for the workspace.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { okList } from '@/lib/api/v1/respond';
import { serializeTemplate, signApiError, signCtx } from '@/lib/api/v1/sign';
import { listActiveTemplates } from '@/lib/sign/service/templates';

export async function GET(request: Request) {
  try {
    const api = await requireApiKey(request, 'sign:read');
    const ctx = await signCtx(request, api);
    const rows = await listActiveTemplates(ctx);
    return okList(rows.map((r) => serializeTemplate(r.template, r.version)), null);
  } catch (err) {
    return signApiError(err);
  }
}
