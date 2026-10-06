// ============================================================
// POST /api/sign/documents/[id]/expiry   (sign.send)   { expiresAt }
//
// Give the people who have not finished more time. Only while the document is sent or in progress, and only to
// a time later than now and later than the current expiry. Nothing else about the document is reopened. The
// change is an audit event with the old and the new time.
// ============================================================
import { UUID_RE, json, readJson, staff } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { extendExpiry } from "@/lib/sign/service/progress";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return staff(
    "sign.send",
    request,
    async ({ ctx }) => {
      const { id } = await params;
      if (!UUID_RE.test(id)) throw new SignError("document_not_found", "That document was not found.", 404);
      const body = await readJson<{ expiresAt?: unknown }>(request);
      return json(await extendExpiry(ctx, id, body.expiresAt));
    },
    { rate: { limit: 30, windowMs: 60_000 } },
  );
}
