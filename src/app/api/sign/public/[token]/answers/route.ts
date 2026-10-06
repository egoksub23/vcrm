// ============================================================
// PUT /api/sign/public/[token]/answers
//   { answers: { [key]: { text | checked | image | typed | choices | list } }, confirmParts?: string[] }
//
// Save what the signer has entered so far (autosave). The keys are placed fields and, for a document with a
// form, data fields. Each value is checked for its field on the server; the answer lists what was saved and
// what was rejected and why (and, for a form, where each part stands). An empty value clears the answer. Only
// the fields of this signer's role can be written. `confirmParts` re-saves the part's answers that came from
// the contact as the signer's own.
// ============================================================
import { json, publicLink, readJson } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { saveAnswers } from "@/lib/sign/service/signing";
import type { AnyAnswerInput } from "@/lib/sign/service/signing";

export async function PUT(request: Request, { params }: { params: Promise<{ token: string }> }) {
  return publicLink(
    request,
    params,
    async ({ ctx, lookup, sessionOk }) => {
      if (lookup.doc.code_required && !sessionOk) throw new SignError("code_required", "Enter the code first.", 403);
      const body = await readJson<{ answers?: unknown; confirmParts?: unknown }>(request, 2_500_000);
      if (typeof body.answers !== "object" || body.answers === null || Array.isArray(body.answers)) throw new SignError("bad_answers", "The answers are not valid.", 400);
      if (body.confirmParts !== undefined && (!Array.isArray(body.confirmParts) || body.confirmParts.length > 20 || body.confirmParts.some((p) => typeof p !== "string"))) {
        throw new SignError("bad_answers", "The answers are not valid.", 400);
      }
      return json(await saveAnswers(ctx, lookup, body.answers as Record<string, AnyAnswerInput>, { confirmParts: body.confirmParts as string[] | undefined }));
    },
    { rate: { limit: 240, windowMs: 60_000 } },
  );
}
