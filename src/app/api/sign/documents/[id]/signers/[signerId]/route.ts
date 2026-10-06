// ============================================================
// POST /api/sign/documents/[id]/signers/[signerId]   (sign.send)
//
// Something to do about one person who has not signed yet:
//   { "action": "remind" }                                  a reminder with a fresh link
//   { "action": "resend" }                                  the invitation again with a fresh link
//   { "action": "recipient", fullName, email, phone?, channel? }  a different person or address
// Each replaces the person's link: the earlier one stops working.
// ============================================================
import { UUID_RE, json, readJson, staff } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { changeRecipient, remindSigner, resendSigner } from "@/lib/sign/service/send";

export async function POST(request: Request, { params }: { params: Promise<{ id: string; signerId: string }> }) {
  return staff(
    "sign.send",
    request,
    async ({ ctx }) => {
      const { id, signerId } = await params;
      if (!UUID_RE.test(id) || !UUID_RE.test(signerId)) throw new SignError("signer_not_found", "That person is not on this document.", 404);
      const body = await readJson<{ action?: unknown; fullName?: unknown; email?: unknown; phone?: unknown; channel?: unknown }>(request);
      switch (body.action) {
        case "remind":
          return json({ result: await remindSigner(ctx, id, signerId) });
        case "resend":
          return json({ result: await resendSigner(ctx, id, signerId) });
        case "recipient":
          return json({
            result: await changeRecipient(ctx, id, signerId, {
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
