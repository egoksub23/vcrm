// ============================================================
// POST /api/sign/documents/[id]/void   (sign.void)
//
// Cancel a document that was sent and has not finished. Every link then shows that it was cancelled, and
// the people who were waiting are told. `reason` is kept in the audit trail.
// ============================================================
import { UUID_RE, json, readJson, staff } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { voidDocument } from "@/lib/sign/service/send";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return staff("sign.void", request, async ({ ctx }) => {
    const { id } = await params;
    if (!UUID_RE.test(id)) throw new SignError("document_not_found", "That document was not found.", 404);
    const body = await readJson<{ reason?: unknown }>(request);
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 1000) : "";
    if (!reason) throw new SignError("reason_required", "Say why this document is being cancelled.", 400);
    await voidDocument(ctx, id, reason);
    return json({ voided: true });
  });
}
