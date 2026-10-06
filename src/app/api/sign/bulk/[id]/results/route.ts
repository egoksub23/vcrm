// ============================================================
// GET /api/sign/bulk/[id]/results   (menu.sign)
//
// The batch's result file as CSV, one line per person of the list (row, name, email, phone, result, reference,
// document id, error code, error message). A person still waiting reads "pending". Cells that start with
// = + - @ are guarded against spreadsheet formulas.
// ============================================================
import { NextResponse } from "next/server";

import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { resultFileName, resultHeaderLine, resultLines, type ResultRow } from "@/lib/sign/bulk/results";
import { staff } from "@/lib/sign/http";
import { bulkResultRows } from "@/lib/sign/service/bulk";
import { assertSignOn } from "@/lib/sign/service/gate";

const PAGE = 250;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return staff("menu.sign", request, async ({ ctx, auth }) => {
    await assertSignOn(ctx);
    const rate = checkRateLimit(`sign-bulk-results:${auth.userId}`, RATE_LIMITS.adminAction);
    if (!rate.success) return rateLimitResponse(rate);
    const { id } = await params;
    // a batch holds at most 500 people: two pages, built whole
    const first = await bulkResultRows(ctx, id, 0, PAGE);
    const rows: ResultRow[] = [...first.rows];
    for (let offset = PAGE; rows.length === offset && offset < 1000; offset += PAGE) rows.push(...(await bulkResultRows(ctx, id, offset, PAGE)).rows);
    // BOM so Excel reads non-ASCII names as UTF-8
    const body = "\uFEFF" + resultHeaderLine() + resultLines(rows);
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${resultFileName(first.job.template_name, first.job.created_at)}"`,
        "Cache-Control": "no-store",
      },
    });
  });
}
