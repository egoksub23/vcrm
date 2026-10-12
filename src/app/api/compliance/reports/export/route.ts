// ============================================================
// GET /api/compliance/reports/export?from=&to=&type=   (menu.compliance and compliance.review or compliance.approve)
//
// The CSV of the cases requested in the range, newest first, at most 5,000 rows. Columns: reference, type, source, status, received_at, target_due_at,
// hard_stop_at, decided_at, completed_at, days_to_complete, outcome. NO name, phone number, email address, bank detail, reason or note. The export is
// recorded first (who, the filters, how many rows) in the exports log; when that cannot be written nothing is returned (503 audit_failed). A file, never
// cached, never sniffed, 10 an hour per person.
// ============================================================
import { complianceStaff, json } from "@/lib/compliance/http";
import { exportReportCsv, parseReportFilters } from "@/lib/compliance/service/reports";
import { checkRateLimit } from "@/lib/rate-limit";

export async function GET(request: Request) {
  return complianceStaff({ bucket: "reports-export", perMinute: 20, needAny: ["compliance.review", "compliance.approve"] }, async ({ admin, caller }) => {
    // an export is rare and heavy: ten an hour per person, on top of the minute's allowance
    const hourly = checkRateLimit(`compliance:${caller.userId}:reports-export-hour`, { limit: 10, windowMs: 60 * 60_000 });
    if (!hourly.success) return json({ error: "rate_limited", code: "rate_limited" }, 429);
    const result = await exportReportCsv(admin, caller, parseReportFilters(new URL(request.url).searchParams));
    return new Response(result.csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="compliance-requests.csv"',
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Rows": String(result.rows),
        "X-Rows-Truncated": result.truncated ? "1" : "0",
      },
    });
  });
}
