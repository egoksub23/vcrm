// ============================================================
// POST /api/sign/documents/[id]/sensitive   (sign.reveal-sensitive)   { field }
//
// Reveal one sensitive answer (an ID number, a bank account) of a document in full. The sender's screens show such an
// answer masked; this is the only way a person gets the value. The `sensitive_viewed` event (who, which field of which
// document, never the value) is written first and the call fails when it cannot be recorded. Twenty reveals a minute
// per person, counted in the database so it holds across processes. The field is in the body, not the address, so it
// is not in a log of addresses. The answer is never cached.
//
// Decision (migration 176): its own capability, sign.reveal-sensitive (Owner and Admin by default), no longer sign.send. A person can send and
// follow documents without being able to read the numbers people typed into them; an admin gives the capability to the roles that must (a
// compliance officer, an operations role). Everyone with menu.sign still sees the mask, and every reveal is in the document's history.
// This is only the Reveal action: who may read sensitive answers in the sealed PDF, the zip and the uploaded files is a separate decision (F8) and
// is unchanged here.
// ============================================================
import { UUID_RE, json, readJson, sharedLimit, staff } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { revealAnswer } from "@/lib/sign/service/sensitive-staff";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return staff("sign.reveal-sensitive", request, async ({ ctx }) => {
    const { id } = await params;
    if (!UUID_RE.test(id)) throw new SignError("document_not_found", "That document was not found.", 404);
    if (!(await sharedLimit(`sign-reveal:${ctx.userId}`, 20, 60_000))) throw new SignError("rate_limited", "Too many requests. Wait a moment and try again.", 429);
    const body = await readJson<{ field?: unknown }>(request, 2_000);
    return json(await revealAnswer(ctx, id, body.field));
  });
}
