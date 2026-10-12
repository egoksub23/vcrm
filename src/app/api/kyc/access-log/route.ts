// ============================================================
// GET /api/kyc/access-log[?user_id=&friend_id=&action=&from=&to=&before=&limit=]   (menu.kyc, and an admin or owner of the workspace)
//
// The latest rows of the workspace's KYC access log, newest first, with the people's names and the list of people for the filter. Rows hold who did
// what to which friend id and validation id and how it ended; never a key, an image or a field value. 100 rows a page (at most 200); `before` is the
// `createdAt` of the last row of the previous page. Reading the log does not change it (it is append-only in the database).
// ============================================================
import { failure, json, kycStaff } from "@/lib/kyc/http";
import { PAGE_DEFAULT, listAccessLog, parseLogFilters } from "@/lib/kyc/audit";

export async function GET(request: Request) {
  return kycStaff({ bucket: "access-log", perMinute: 60, adminOnly: true }, async ({ admin, caller }) => {
    const params = new URL(request.url).searchParams;
    const limit = Number(params.get("limit"));
    const result = await listAccessLog(admin, caller.accountId, parseLogFilters(params), Number.isFinite(limit) && limit > 0 ? limit : PAGE_DEFAULT);
    if (!result) return failure("bad_response");
    return json(result);
  });
}
