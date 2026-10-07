// ============================================================
// POST /api/sign/envelopes/[id]/retry-seal   (sign.send)
//
// The same as a document's retry-seal, for every document of the collection that stopped before its signed copy was made. Nothing the people
// signed is touched. 409 seal_not_stuck when no document of the collection is stuck.
// ============================================================
import { UUID_RE, json, staff } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { sealAfterResponse } from "@/lib/sign/service/seal-after";
import { retryEnvelopeSealing } from "@/lib/sign/service/seal-retry";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return staff(
    "sign.send",
    request,
    async ({ ctx }) => {
      const { id } = await params;
      if (!UUID_RE.test(id)) throw new SignError("envelope_not_found", "That document collection was not found.", 404);
      const result = await retryEnvelopeSealing(ctx, id);
      sealAfterResponse(ctx);
      return json(result);
    },
    { rate: { limit: 10, windowMs: 60_000 } },
  );
}
