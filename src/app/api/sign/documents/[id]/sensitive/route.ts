// ============================================================
// POST /api/sign/documents/[id]/sensitive   (sign.send)   { field }
//
// Reveal one sensitive answer (an ID number, a bank account) of a document in full. The sender's screens show such an
// answer masked; this is the only way a person gets the value. The `sensitive_viewed` event (who, which field of which
// document, never the value) is written first and the call fails when it cannot be recorded. Twenty reveals a minute
// per person, counted in the database so it holds across processes. The field is in the body, not the address, so it
// is not in a log of addresses. The answer is never cached.
//
// Decision: sign.send, not sign.settings. The people who send and follow documents are the ones who must read an ID
// number to carry the application on; settings is for the workspace's administrators. Everyone with menu.sign sees the
// mask; revealing needs the capability to act on documents, and every reveal is in the document's history.
// ============================================================
import { UUID_RE, json, readJson, sharedLimit, staff } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { revealAnswer } from "@/lib/sign/service/sensitive-staff";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return staff("sign.send", request, async ({ ctx }) => {
    const { id } = await params;
    if (!UUID_RE.test(id)) throw new SignError("document_not_found", "That document was not found.", 404);
    if (!(await sharedLimit(`sign-reveal:${ctx.userId}`, 20, 60_000))) throw new SignError("rate_limited", "Too many requests. Wait a moment and try again.", 429);
    const body = await readJson<{ field?: unknown }>(request, 2_000);
    return json(await revealAnswer(ctx, id, body.field));
  });
}
