// ============================================================
// POST /api/sign/documents/zip   (menu.sign)
//
// The signed files of up to 50 chosen documents as one zip: JSON { ids: [...] }. Only a completed document has a
// signed file (the sealed PDF, which already carries its certificate pages and audit trail); the others are left
// out and reported in two ways: the headers `X-Sign-Zip-Included` and `X-Sign-Zip-Skipped` (counts), and a
// NOT-INCLUDED.txt note inside the zip. When none of them can be downloaded the answer is 409 `nothing_to_download`
// and no zip is made. The files are named by reference and title, and read one at a time while the zip streams.
// Each document that goes in is recorded in its history as `downloaded`.
// ============================================================
import { NextResponse } from "next/server";

import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { cleanIds, zipFileName, ZIP_MAX_DOCUMENTS } from "@/lib/sign/export/zip";
import { UUID_RE, readJson, staff } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { planZip, zipStream } from "@/lib/sign/service/export";
import { assertSignOn } from "@/lib/sign/service/gate";

export async function POST(request: Request) {
  return staff("menu.sign", request, async ({ ctx, auth }) => {
    await assertSignOn(ctx);
    const rate = checkRateLimit(`sign-zip:${auth.userId}`, RATE_LIMITS.adminAction);
    if (!rate.success) return rateLimitResponse(rate);
    const body = await readJson<{ ids?: unknown }>(request, 20_000);
    const ids = cleanIds(body.ids, (v) => UUID_RE.test(v));
    if (!ids) throw new SignError("bad_ids", `Choose between 1 and ${ZIP_MAX_DOCUMENTS} documents.`, 400);
    const plan = await planZip(ctx, ids);
    return new NextResponse(zipStream(ctx, plan), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${zipFileName(ctx.now())}"`,
        "X-Sign-Zip-Included": String(plan.included.length),
        "X-Sign-Zip-Skipped": String(plan.skipped.length),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
