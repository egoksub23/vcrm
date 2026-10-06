// ============================================================
// POST /api/sign/documents/[id]/send   (sign.send)
//
// Send a prepared draft. The file is frozen with the sender's values, the document moves to "sent", and
// the first person (everyone, unless the document needs signing order) is invited. The answer says, for
// each invitation, whether the message was delivered; a link is only returned for one that was not, so
// the sender can pass it on.
// ============================================================
import { UUID_RE, json, staff } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { sendDocument } from "@/lib/sign/service/send";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return staff(
    "sign.send",
    request,
    async ({ ctx }) => {
      const { id } = await params;
      if (!UUID_RE.test(id)) throw new SignError("document_not_found", "That document was not found.", 404);
      return json(await sendDocument(ctx, id));
    },
    { rate: { limit: 20, windowMs: 60_000 } },
  );
}
