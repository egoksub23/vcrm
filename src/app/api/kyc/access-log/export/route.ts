// ============================================================
// GET /api/kyc/access-log/export[?user_id=&friend_id=&action=&from=&to=]   (menu.kyc, and an admin or owner of the workspace)
//
// The access log as a CSV file under the same filters, newest first, at most 5,000 rows (the screen says when the file was cut). Cells that start with
// = + - @ are guarded against spreadsheet formulas. Six a minute per person. Never cached.
// ============================================================
import { NextResponse } from "next/server";

import { EXPORT_MAX_ROWS, exportAccessLogCsv, parseLogFilters } from "@/lib/kyc/audit";
import { failure, kycStaff } from "@/lib/kyc/http";

export async function GET(request: Request) {
  return kycStaff({ bucket: "access-log-export", perMinute: 6, adminOnly: true }, async ({ admin, caller }) => {
    const out = await exportAccessLogCsv(admin, caller.accountId, parseLogFilters(new URL(request.url).searchParams));
    if (!out) return failure("bad_response");
    const stamp = new Date().toISOString().slice(0, 10);
    return new NextResponse(`\uFEFF${out.csv}`, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="kyc-access-log-${stamp}.csv"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Row-Count": String(out.rows),
        "X-Truncated": out.truncated ? String(EXPORT_MAX_ROWS) : "0",
      },
    });
  });
}
