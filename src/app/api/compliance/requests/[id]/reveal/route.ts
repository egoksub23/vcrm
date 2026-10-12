// ============================================================
// POST /api/compliance/requests/[id]/reveal   (menu.compliance and compliance.reveal)
//
// The sensitive answers of ONE case (bank name, account number, account holder, anything the type marks sensitive) in full, for two minutes: the
// screen hides them again after that. A POST so no cache or history keeps the answer. The 'reveal' event is written BEFORE the values are returned
// (and when it cannot be written nothing is returned); a refused attempt is an event too. Ten reveals a minute per person, counted in the database
// so it holds across servers. The answer is never cached.
// ============================================================
import { complianceStaff, failure, json, rateLimited, UUID_RE } from "@/lib/compliance/http";
import { revealSensitive } from "@/lib/compliance/service/actions";
import { checkSharedRateLimit } from "@/lib/rate-limit-shared";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return complianceStaff({ bucket: "reveal", perMinute: 30, need: "compliance.reveal" }, async ({ admin, caller }) => {
    const { id } = await params;
    if (!UUID_RE.test(id)) return failure("not_found");
    const rate = await checkSharedRateLimit(`compliance-reveal:${caller.userId}`, { limit: 10, windowMs: 60_000 });
    if (!rate.success) return rateLimited(rate.reset);
    return json(await revealSensitive(admin, caller, id));
  });
}
