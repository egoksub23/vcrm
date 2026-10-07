// ============================================================
// POST /api/sign/envelopes/[id]/send   (sign.send)
//
// Send a prepared draft envelope: every document is checked, frozen and sent in one step, and each person of the first step gets ONE invitation
// with ONE link for all their documents. The month's limit is checked for ALL the documents first (429 sign_limit_reached, with how many were
// needed and how many are left); an envelope that does not fit is not sent. The answer says, for each invitation, whether the message was
// delivered; a link is only returned for one that was not, so the sender can pass it on.
// ============================================================
import { UUID_RE, json, staff } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { sendEnvelope } from "@/lib/sign/service/envelopes";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return staff(
    "sign.send",
    request,
    async ({ ctx }) => {
      const { id } = await params;
      if (!UUID_RE.test(id)) throw new SignError("envelope_not_found", "That document collection was not found.", 404);
      return json(await sendEnvelope(ctx, id));
    },
    { rate: { limit: 10, windowMs: 60_000 } },
  );
}
