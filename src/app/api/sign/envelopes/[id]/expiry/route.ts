// ============================================================
// POST /api/sign/envelopes/[id]/expiry   (sign.send)   { expiresAt }
//
// Give the people who have not finished more time: the same new expiry on every document that is still open, and on the envelope. The same rules
// as for a document (later than now and than the current expiry, at most a year ahead); each document records the change in its audit trail.
// ============================================================
import { UUID_RE, json, readJson, staff } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { extendEnvelopeExpiry } from "@/lib/sign/service/envelopes";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return staff(
    "sign.send",
    request,
    async ({ ctx }) => {
      const { id } = await params;
      if (!UUID_RE.test(id)) throw new SignError("envelope_not_found", "That document collection was not found.", 404);
      const body = await readJson<{ expiresAt?: unknown }>(request);
      return json(await extendEnvelopeExpiry(ctx, id, body.expiresAt));
    },
    { rate: { limit: 30, windowMs: 60_000 } },
  );
}
