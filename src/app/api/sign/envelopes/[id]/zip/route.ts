// ============================================================
// GET /api/sign/envelopes/[id]/zip   (menu.sign)
//
// "Download all (zip)" of a document collection: the signed file of every completed document with its certificate, and one small
// "Collection summary" PDF (the collection's reference and title, and for each document its fingerprint and who signed). A document that is not
// completed is left out and named in NOT-INCLUDED.txt; when none has a signed file the answer is 409 `nothing_to_download`. It is the same zip as
// the documents list makes (service/export.ts), with the summary added. A private collection the caller may not see is a 404, like any other
// read of it. Each document that goes in is recorded in its history as `downloaded`.
// ============================================================
import { NextResponse } from "next/server";

import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { UUID_RE, staff } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { planEnvelopeZip, zipStream } from "@/lib/sign/service/export";
import { assertSignOn } from "@/lib/sign/service/gate";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return staff("menu.sign", request, async ({ ctx, auth }) => {
    await assertSignOn(ctx);
    const rate = checkRateLimit(`sign-zip:${auth.userId}`, RATE_LIMITS.adminAction);
    if (!rate.success) return rateLimitResponse(rate);
    const { id } = await params;
    if (!UUID_RE.test(id)) throw new SignError("envelope_not_found", "That document collection was not found.", 404);
    const { plan, extras, fileName } = await planEnvelopeZip(ctx, id);
    return new NextResponse(zipStream(ctx, plan, { extras }), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${fileName.replace(/"/g, "")}"`,
        "X-Sign-Zip-Included": String(plan.included.length),
        "X-Sign-Zip-Skipped": String(plan.skipped.length),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
