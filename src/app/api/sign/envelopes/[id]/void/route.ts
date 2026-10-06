// ============================================================
// POST /api/sign/envelopes/[id]/void   (sign.void)   { reason }
//
// Cancel an envelope that was sent: every document that is still open, together. Only while no document is fully signed (409
// envelope_partly_completed after that: the people can still finish, or it expires). Every link then shows that it was cancelled, and the people
// who were waiting are told once. `reason` is kept in each document's audit trail.
// ============================================================
import { UUID_RE, json, readJson, staff } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { voidEnvelope } from "@/lib/sign/service/envelopes";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return staff("sign.void", request, async ({ ctx }) => {
    const { id } = await params;
    if (!UUID_RE.test(id)) throw new SignError("envelope_not_found", "That envelope was not found.", 404);
    const body = await readJson<{ reason?: unknown }>(request);
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 1000) : "";
    if (!reason) throw new SignError("reason_required", "Say why this envelope is being cancelled.", 400);
    await voidEnvelope(ctx, id, reason);
    return json({ voided: true });
  });
}
