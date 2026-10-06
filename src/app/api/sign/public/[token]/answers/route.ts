// ============================================================
// PUT /api/sign/public/[token]/answers   { answers: { [fieldKey]: { text | checked | image | typed } } }
//
// Save what the signer has entered so far (autosave). Each value is checked for its field on the server;
// the answer lists what was saved and what was rejected and why. An empty value clears the answer. Only
// the fields of this signer's role can be written.
// ============================================================
import { json, publicLink, readJson } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { saveAnswers } from "@/lib/sign/service/signing";
import type { AnswerInput } from "@/lib/sign/rules";

export async function PUT(request: Request, { params }: { params: Promise<{ token: string }> }) {
  return publicLink(
    request,
    params,
    async ({ ctx, lookup, sessionOk }) => {
      if (lookup.doc.code_required && !sessionOk) throw new SignError("code_required", "Enter the code first.", 403);
      const body = await readJson<{ answers?: unknown }>(request, 2_500_000);
      if (typeof body.answers !== "object" || body.answers === null || Array.isArray(body.answers)) throw new SignError("bad_answers", "The answers are not valid.", 400);
      return json(await saveAnswers(ctx, lookup, body.answers as Record<string, AnswerInput>));
    },
    { rate: { limit: 240, windowMs: 60_000 } },
  );
}
