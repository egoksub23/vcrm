// ============================================================
// POST /api/sign/public/[token]/complete   { answers?, locale?, check? }
//
// Finish: the last answers are saved, every required field must be answered, the signature is recorded,
// and the next person is invited or, when this was the last, the document is sealed. The answer says
// whether sealing began and who was invited next. For a document with a form the server checks again that the
// signer's parts are complete and sound and that every answer fits where it is printed (400 missing_required,
// invalid_answers or answer_does_not_fit, with the fields), and after the signature the confirmed answers are
// written back to the contact. With `check: true` (an envelope's "next document") every rule is applied and
// nothing is changed: the answer is `{ checked: true }`.
// ============================================================
import { json, publicLink, readJson } from "@/lib/sign/http";
import { sealAfterResponse } from "@/lib/sign/service/seal-after";
import { SignError } from "@/lib/sign/service/errors";
import { completeSigning, codeRequiredFor } from "@/lib/sign/service/signing";
import type { AnyAnswerInput } from "@/lib/sign/service/signing";
import { SIGN_LOCALES } from "@/lib/sign/types";

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  return publicLink(
    request,
    params,
    async ({ ctx, lookup, sessionOk, ip, device }) => {
      if (codeRequiredFor(lookup) && !sessionOk) throw new SignError("code_required", "Enter the code first.", 403);
      const body = await readJson<{ answers?: unknown; locale?: unknown; check?: unknown }>(request, 2_500_000);
      const answers = body.answers === undefined ? {} : body.answers;
      if (typeof answers !== "object" || answers === null || Array.isArray(answers)) throw new SignError("bad_answers", "The answers are not valid.", 400);
      const locale = typeof body.locale === "string" && SIGN_LOCALES.includes(body.locale as never) ? body.locale : null;
      const result = await completeSigning(ctx, lookup, answers as Record<string, AnyAnswerInput>, { ip, device, locale }, { check: body.check === true });
      if (result.checked) return json({ checked: true });
      // the last signature: make the signed copy now, after this answer has gone, instead of waiting for the minute job
      if (result.sealing) sealAfterResponse(ctx);
      return json({ completed: true, sealing: result.sealing });
    },
    { rate: { limit: 20, windowMs: 60_000 } },
  );
}
