// ============================================================
// GET /api/compliance/reports?from=&to=&type=   (menu.compliance and compliance.review or compliance.approve)
//
// The numbers of the Compliance reports page for the cases REQUESTED in the range (ISO instants: from inclusive, to exclusive; none: all time): counts by
// type and status, the cases with a regulatory clock against the practice target and the stop, the average and the median days to the decision and to
// completion, sign-offs by person, rejections by category, and the ageing of the open cases. No name, phone number, bank detail or reason is in it.
// At most 5,000 cases are read (the newest); `truncated` says when there were more.
// ============================================================
import { complianceStaff, json } from "@/lib/compliance/http";
import { loadReport, parseReportFilters } from "@/lib/compliance/service/reports";

export async function GET(request: Request) {
  return complianceStaff({ bucket: "reports", perMinute: 30, needAny: ["compliance.review", "compliance.approve"] }, async ({ admin, caller }) =>
    json(await loadReport(admin, caller, parseReportFilters(new URL(request.url).searchParams))),
  );
}
