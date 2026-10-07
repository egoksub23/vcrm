// ============================================================
// POST /api/sign/documents/[id]/retry-seal   (sign.send)
//
// Ask for another try at making the signed copy of a document whose people have all signed but whose sealing stopped (the document is marked
// "could not finish", or is still being tried with an error on it). Nothing the people signed is touched. The document goes back to being
// sealed, the request is written in its history with who asked, and the sealing is attempted right after the answer goes out (the minute job
// does it otherwise). 409 seal_not_stuck for a document that is not stuck.
// ============================================================
import { UUID_RE, json, staff } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { sealAfterResponse } from "@/lib/sign/service/seal-after";
import { retrySealing } from "@/lib/sign/service/seal-retry";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return staff(
    "sign.send",
    request,
    async ({ ctx }) => {
      const { id } = await params;
      if (!UUID_RE.test(id)) throw new SignError("document_not_found", "That document was not found.", 404);
      const result = await retrySealing(ctx, id);
      sealAfterResponse(ctx);
      return json(result);
    },
    { rate: { limit: 10, windowMs: 60_000 } },
  );
}
