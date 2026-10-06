// ============================================================
// POST /api/sign/documents/[id]/forwarding   (sign.send)   { allow: boolean }
//
// The sender's switch for one document: may the people on it hand their turn, or a part of the form, to someone
// else? Allowed on a draft and while the document is sent or in progress. Turning it off stops new forwards and
// leaves what was already handed over as it is. A change after sending is an audit event.
// ============================================================
import { UUID_RE, json, readJson, staff } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { setForwarding } from "@/lib/sign/service/forward";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return staff(
    "sign.send",
    request,
    async ({ ctx }) => {
      const { id } = await params;
      if (!UUID_RE.test(id)) throw new SignError("document_not_found", "That document was not found.", 404);
      const body = await readJson<{ allow?: unknown }>(request, 2000);
      return json(await setForwarding(ctx, id, body.allow));
    },
    { rate: { limit: 30, windowMs: 60_000 } },
  );
}
