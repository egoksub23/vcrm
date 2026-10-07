// ============================================================
// POST /api/sign/public/[token]/envelope/finish   { answers?, locale? }
//
// Finish an envelope (migration 171): every document of the person that is still theirs to do is completed, in order, each through the
// same rules as a document on its own. `answers` may carry last answers by document id; the page normally has nothing to add, it saved as
// the person went. A document that cannot be completed stops the run with its id on every problem (the documents before it stay signed);
// the page shows what remains and Finish can be pressed again. A link that is not an envelope's answers 400.
// ============================================================
import { json, publicLink, readJson } from "@/lib/sign/http";
import { sealAfterResponse } from "@/lib/sign/service/seal-after";
import { finishEnvelope } from "@/lib/sign/service/envelope-signing";
import { SignError } from "@/lib/sign/service/errors";
import { codeRequiredFor, type AnyAnswerInput } from "@/lib/sign/service/signing";
import { SIGN_LOCALES } from "@/lib/sign/types";

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  return publicLink(
    request,
    params,
    async ({ ctx, lookup, sessionOk, ip, device }) => {
      if (!lookup.party) throw new SignError("not_an_envelope", "This link is not for a document collection.", 400);
      if (codeRequiredFor(lookup) && !sessionOk) throw new SignError("code_required", "Enter the code first.", 403);
      const body = await readJson<{ answers?: unknown; locale?: unknown }>(request, 2_500_000);
      const answers = body.answers === undefined ? {} : body.answers;
      if (typeof answers !== "object" || answers === null || Array.isArray(answers)) throw new SignError("bad_answers", "The answers are not valid.", 400);
      const locale = typeof body.locale === "string" && SIGN_LOCALES.includes(body.locale as never) ? body.locale : null;
      const result = await finishEnvelope(ctx, lookup, answers as Record<string, Record<string, AnyAnswerInput>>, { ip, device, locale });
      // a document of the collection has every signature now: make its signed copy right away, after this answer has gone
      if (result.sealing) sealAfterResponse(ctx);
      return json(result);
    },
    { rate: { limit: 20, windowMs: 60_000 } },
  );
}
