// ============================================================
// POST /api/sign/envelopes/[id]/people/[anchorId]   (sign.send)
//
// Something to do about one PERSON of a sent envelope who has not finished (`anchorId` is the id of their row on their first document, which is the
// one that has their link). It acts on all their documents at once, with one message and one new link; the earlier link stops working:
//   { "action": "remind" }                                       a reminder naming the documents they have left
//   { "action": "resend" }                                       the invitation again
//   { "action": "recipient", fullName, email, phone?, channel? } a different person or address (refused once they have signed one of the documents)
// ============================================================
import { UUID_RE, json, readJson, staff } from "@/lib/sign/http";
import { changeEnvelopeRecipient, remindEnvelopePerson, resendEnvelopePerson } from "@/lib/sign/service/envelopes";
import { SignError } from "@/lib/sign/service/errors";

export async function POST(request: Request, { params }: { params: Promise<{ id: string; anchorId: string }> }) {
  return staff(
    "sign.send",
    request,
    async ({ ctx }) => {
      const { id, anchorId } = await params;
      if (!UUID_RE.test(id) || !UUID_RE.test(anchorId)) throw new SignError("signer_not_found", "That person is not on this envelope.", 404);
      const body = await readJson<{ action?: unknown; fullName?: unknown; email?: unknown; phone?: unknown; channel?: unknown }>(request);
      switch (body.action) {
        case "remind":
          return json({ result: await remindEnvelopePerson(ctx, id, anchorId) });
        case "resend":
          return json({ result: await resendEnvelopePerson(ctx, id, anchorId) });
        case "recipient":
          return json({
            result: await changeEnvelopeRecipient(ctx, id, anchorId, {
              fullName: String(body.fullName ?? ""),
              email: String(body.email ?? ""),
              phone: typeof body.phone === "string" ? body.phone : null,
              channel: body.channel === "whatsapp" ? "whatsapp" : body.channel === "email" ? "email" : undefined,
            }),
          });
        default:
          throw new SignError("bad_action", "Choose remind, resend or recipient.", 400);
      }
    },
    { rate: { limit: 30, windowMs: 60_000 } },
  );
}
