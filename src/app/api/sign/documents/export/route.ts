// ============================================================
// GET /api/sign/documents/export   (menu.sign)
//
// The documents list as a CSV download, streamed in pages so a long list is never cut at the database's
// 1,000-row answer and never held in memory (at most 50,000 documents). The filters are the list's own:
//   status    all | draft | waiting | completed | stopped
//   category  all | none | a category id
//   q         search of title, reference and signer name or email
//   contact   a contact id
//   from, to  YYYY-MM-DD, the day a document was made, in the workspace's time zone
// Columns: reference, title, category, status, contact, signers, created, sent, completed, expires. Cells that
// start with = + - @ are prefixed with an apostrophe (spreadsheet formula guard).
// ============================================================
import { NextResponse } from "next/server";

import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { exportFileName, parseExportFilters } from "@/lib/sign/export/documents";
import { staff } from "@/lib/sign/http";
import { documentsCsvStream } from "@/lib/sign/service/export";
import { assertSignOn } from "@/lib/sign/service/gate";

export async function GET(request: Request) {
  return staff("menu.sign", request, async ({ ctx, auth }) => {
    await assertSignOn(ctx);
    const rate = checkRateLimit(`sign-export:${auth.userId}`, RATE_LIMITS.adminAction);
    if (!rate.success) return rateLimitResponse(rate);
    const filters = parseExportFilters(new URL(request.url).searchParams);
    return new NextResponse(documentsCsvStream(ctx, filters), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${exportFileName(ctx.now())}"`,
        "Cache-Control": "no-store",
      },
    });
  });
}
