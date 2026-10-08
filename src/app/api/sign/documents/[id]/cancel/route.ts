// ============================================================
// POST /api/sign/documents/[id]/cancel   (menu.sign + the person who sent it, or an admin)   { reason, notify }
//
// Cancel a COMPLETED document (migration 181). The signed file, the certificate and the history are not touched and the status stays "completed": the
// document is stamped cancelled (when, by whom, why), which the list, the detail page, the verify page and the API all show. No undo: send a new document.
//
//   reason   required, 3 to 500 characters.
//   notify   true to email the signers, the people who receive a copy and the sender one short notice (default false).
//
// 403 cancel_not_allowed (not the sender and not an admin), 404 (not found, or a private document the caller cannot see), 409 document_not_completed,
// 409 document_already_cancelled, 409 belongs_to_collection (the document is part of a collection: `issues[0].detail` is the collection's id; cancel
// the collection, which cancels every document in it), 400 cancel_reason_invalid. Rate limited to 20 a minute for each person.
// ============================================================
import { UUID_RE, json, readJson, staff } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { cancelDocument, parseCancelRequest } from "@/lib/sign/service/cancel";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return staff(
    "menu.sign",
    request,
    async ({ ctx }) => {
      const { id } = await params;
      if (!UUID_RE.test(id)) throw new SignError("document_not_found", "That document was not found.", 404);
      const input = parseCancelRequest(await readJson<{ reason?: unknown; notify?: unknown }>(request, 20_000));
      return json(await cancelDocument(ctx, id, input));
    },
    { rate: { limit: 20, windowMs: 60_000 } },
  );
}
