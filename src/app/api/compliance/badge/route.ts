// ============================================================
// GET /api/compliance/badge   (menu.compliance and compliance.review or compliance.approve)
//
// The number on the sidebar's Compliance item: for a holder of compliance.approve the cases awaiting sign-off that they could sign (not one whose identity
// check they recorded); for a holder of compliance.review the cases waiting for an identity check or an officer's review; the sum for a person with both.
// { count }. Nothing else: no reference, no customer. The sidebar hides it at zero and refreshes it like the Secure Sign badge.
// ============================================================
import { complianceStaff, json } from "@/lib/compliance/http";
import { badgeCount } from "@/lib/compliance/service/reports";

export async function GET() {
  return complianceStaff({ bucket: "badge", perMinute: 120, needAny: ["compliance.review", "compliance.approve"] }, async ({ admin, caller }) => json({ count: await badgeCount(admin, caller) }));
}
