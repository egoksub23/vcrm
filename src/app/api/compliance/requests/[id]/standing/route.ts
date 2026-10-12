// ============================================================
// POST /api/compliance/requests/[id]/standing   (compliance.review or compliance.approve)
//
// Body: { duesOutstanding: boolean, notes?: string }. The "Account standing" block of a closure: a manual yes / no for now (the shape is ready for the
// Vircle back-office API, which will fill it in with source "api"). Only on a type that checks dues and only before the case goes to the Head of
// Compliance. Approval is blocked while dues are outstanding unless the Head records an override reason with the sign-off.
// ============================================================
import { complianceStaff, failure, json, readJsonBody, UUID_RE } from "@/lib/compliance/http";
import { setStanding } from "@/lib/compliance/service/actions";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return complianceStaff({ bucket: "standing", perMinute: 30, needAny: ["compliance.review", "compliance.approve"] }, async ({ admin, caller }) => {
    const { id } = await params;
    if (!UUID_RE.test(id)) return failure("not_found");
    const b = await readJsonBody<Record<string, unknown>>(request, 10_000);
    if (typeof b.duesOutstanding !== "boolean") return failure("invalid_request");
    await setStanding(admin, caller, id, b.duesOutstanding, typeof b.notes === "string" ? b.notes : null);
    return json({ ok: true });
  });
}
