// ============================================================
// GET /api/sign/public/[token]
//
// What a signer's page shows for their link: the state (active, signed, sealing, completed, declined,
// expired, voided, not invited), whether the code is still needed, the consent wording, the document's
// facts, and, once the code (if any) is entered, the fields, what this person and earlier signers have
// entered, and who else is on the document. A token that is not a live link answers 404 and nothing else.
// The first time an active link is opened is recorded as "viewed".
// ============================================================
import { json, publicLink } from "@/lib/sign/http";
import { buildView, markViewed, pageState } from "@/lib/sign/service/signing";

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  return publicLink(request, params, async ({ ctx, lookup, sessionOk, ip, device }) => {
    const needsCode = lookup.doc.code_required && !sessionOk;
    if (!needsCode && pageState(lookup.doc, lookup.signer) === "active") await markViewed(ctx, lookup, ip, device);
    return json(await buildView(ctx, lookup, sessionOk));
  });
}
