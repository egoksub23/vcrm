// ============================================================
// PUT /api/sign/documents/[id]/signers   (sign.send)
//
// Replace a draft's signing list: full name, email, role, channel (email or WhatsApp, with a phone number
// for WhatsApp) and order for each person. The order only matters if the document needs signing order.
// ============================================================
import { UUID_RE, json, readJson, staff } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { setSigners, type SignerInput } from "@/lib/sign/service/drafts";

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return staff("sign.send", request, async ({ ctx }) => {
    const { id } = await params;
    if (!UUID_RE.test(id)) throw new SignError("document_not_found", "That document was not found.", 404);
    const body = await readJson<{ signers?: unknown }>(request);
    if (!Array.isArray(body.signers)) throw new SignError("bad_signers", "Send the list of people.", 400);
    const signers: SignerInput[] = body.signers.map((s) => {
      const x = (s ?? {}) as Record<string, unknown>;
      return {
        roleKey: String(x.roleKey ?? ""),
        kind: x.kind === "filler" ? "filler" : "signer",
        fullName: String(x.fullName ?? ""),
        email: String(x.email ?? ""),
        phone: typeof x.phone === "string" ? x.phone : null,
        channel: x.channel === "whatsapp" ? "whatsapp" : "email",
        orderNo: Number(x.orderNo ?? 0),
        internalUserId: typeof x.internalUserId === "string" && UUID_RE.test(x.internalUserId) ? x.internalUserId : null,
      };
    });
    return json({ signers: await setSigners(ctx, id, signers) });
  });
}
