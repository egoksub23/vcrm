// ============================================================
// POST /api/sign/public/[token]/complete   { answers?, locale? }
//
// Finish: the last answers are saved, every required field must be answered, the signature is recorded,
// and the next person is invited or, when this was the last, the document is sealed. The answer says
// whether sealing began and who was invited next.
// ============================================================
import { json, publicLink, readJson } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { completeSigning } from "@/lib/sign/service/signing";
import type { AnswerInput } from "@/lib/sign/rules";
import { SIGN_LOCALES } from "@/lib/sign/types";

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  return publicLink(
    request,
    params,
    async ({ ctx, lookup, sessionOk, ip, device }) => {
      if (lookup.doc.code_required && !sessionOk) throw new SignError("code_required", "Enter the code first.", 403);
      const body = await readJson<{ answers?: unknown; locale?: unknown }>(request, 2_500_000);
      const answers = body.answers === undefined ? {} : body.answers;
      if (typeof answers !== "object" || answers === null || Array.isArray(answers)) throw new SignError("bad_answers", "The answers are not valid.", 400);
      const locale = typeof body.locale === "string" && SIGN_LOCALES.includes(body.locale as never) ? body.locale : null;
      const result = await completeSigning(ctx, lookup, answers as Record<string, AnswerInput>, { ip, device, locale });
      return json({ completed: true, sealing: result.sealing });
    },
    { rate: { limit: 20, windowMs: 60_000 } },
  );
}
