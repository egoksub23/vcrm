// ============================================================
// POST /api/sign/envelopes/[id]/cancel   (menu.sign + the person who sent it, or an admin)   { reason, notify }
//
// Cancel a COMPLETED document collection (migration 181): the collection and EVERY document in it, together, in one step. Nothing that was signed is
// touched and every status stays "completed"; each document is stamped cancelled with the same date, person and reason. No undo.
//
//   reason   required, 3 to 500 characters.
//   notify   true to email each person of the collection once, the people who receive a copy and the sender (default false).
//
// The same answers as a document's: 403 cancel_not_allowed, 404, 409 envelope_not_completed, 409 envelope_already_cancelled, 400 cancel_reason_invalid.
// ============================================================
import { UUID_RE, json, readJson, staff } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { cancelEnvelope, parseCancelRequest } from "@/lib/sign/service/cancel";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return staff(
    "menu.sign",
    request,
    async ({ ctx }) => {
      const { id } = await params;
      if (!UUID_RE.test(id)) throw new SignError("envelope_not_found", "That document collection was not found.", 404);
      const input = parseCancelRequest(await readJson<{ reason?: unknown; notify?: unknown }>(request, 20_000));
      return json(await cancelEnvelope(ctx, id, input));
    },
    { rate: { limit: 20, windowMs: 60_000 } },
  );
}
