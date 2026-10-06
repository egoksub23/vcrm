// ============================================================
// GET /api/sign/public/[token]/review
//
// The answers as they will be printed on the document, for the signer's last look before they sign: the text
// or tick each bound place gets (all roles' answers, hidden fields left out), and any answer too long for
// the place it prints. Answers 409 `form_incomplete` until every required field of the signer's parts is
// answered. When a code is required it must have been entered.
// ============================================================
import { json, publicLink } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { reviewFor } from "@/lib/sign/service/review";

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  return publicLink(
    request,
    params,
    async ({ ctx, lookup, sessionOk }) => {
      if (lookup.doc.code_required && !sessionOk) throw new SignError("code_required", "Enter the code first.", 403);
      return json(await reviewFor(ctx, lookup));
    },
    { rate: { limit: 60, windowMs: 60_000 } },
  );
}
