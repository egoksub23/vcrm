// ============================================================
// GET  /api/v1/sign/documents  — list documents  (scope: sign:read)
// POST /api/v1/sign/documents  — make a document from a template and send it  (scope: sign:write)
//
// List: keyset-paginated (see src/lib/api/v1/pagination.ts), newest first; filters `status`, `contact_id`,
// `template_id`, `reference`, `created_after`.
//
// Create: one call makes the document and, unless `send: false`, sends it. `copy_to` (up to 10 `{ full_name, email }`) names people who are not
// signers and receive the signed copy by email when everyone has signed; they are part of the same call (and of its replay). All or nothing. `reference` is
// the idempotency key: a document with that reference already in the workspace is returned with 200 and
// `Idempotent-Replay: true`, and nothing is created or sent again. 201 for a new document.
// 403 `sign_disabled` when Doc Sign is off for the workspace.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, okList } from '@/lib/api/v1/respond';
import { parseListParams } from '@/lib/api/v1/pagination';
import { limitSends, parseCreateBody, parseListFilters, readApiJson, serializeBundle, serializeListed, signApiError, signCtx } from '@/lib/api/v1/sign';
import { createDocumentForApi, listDocumentsForApi } from '@/lib/sign/service/api';

export async function GET(request: Request) {
  try {
    const api = await requireApiKey(request, 'sign:read');
    const ctx = await signCtx(request, api);
    const filters = parseListFilters(new URL(request.url));
    const page = await listDocumentsForApi(ctx, filters, parseListParams(request));
    return okList(
      page.documents.map((d) => serializeListed(d, d.template_version_id ? (page.templateIds.get(d.template_version_id) ?? null) : null, page.counts.get(d.id), ctx.origin)),
      page.nextCursor,
    );
  } catch (err) {
    return signApiError(err);
  }
}

export async function POST(request: Request) {
  try {
    const api = await requireApiKey(request, 'sign:write');
    const ctx = await signCtx(request, api);
    limitSends(api);
    const input = parseCreateBody(await readApiJson(request));
    const out = await createDocumentForApi(ctx, input);
    const res = ok(serializeBundle(out, ctx.origin, { invitations: out.replay ? undefined : out.invitations }), out.replay ? 200 : 201);
    if (out.replay) res.headers.set('Idempotent-Replay', 'true');
    return res;
  } catch (err) {
    return signApiError(err);
  }
}
