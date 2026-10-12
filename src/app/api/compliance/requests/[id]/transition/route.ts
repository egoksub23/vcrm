// ============================================================
// POST /api/compliance/requests/[id]/transition   (menu.compliance and the capability the move needs)
//
// Body: { to, note?, identity?: { method, methodOther?, outcome }, recommendation?, overrideReason? }.
//   to officer_review (from received / identity_check)   record the identity check          compliance.review (or approve)
//   to identity_check / awaiting_signoff / closed         start, hand over with a recommendation, close without a decision   compliance.review (or approve)
//   to approved / rejected                                sign-off (reject needs a reason in note)   compliance.approve, and not the person who did the identity check
//   to officer_review (from awaiting_signoff)             send back (note required)         compliance.approve
//   to executing / completed                              operations                        compliance.execute (completed needs every step ticked)
//   to closed (from rejected / completed)                 customer told                     compliance.review (or approve)
// The permission is checked here for an early answer and again in the database function (compliance_transition) for the named person, which also
// holds the transition table, the maker-checker rule and the row lock.
// ============================================================
import { complianceStaff, failure, json, readJsonBody, UUID_RE } from "@/lib/compliance/http";
import { oneStatus } from "@/lib/compliance/routes-support";
import { transitionRequest } from "@/lib/compliance/service/actions";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return complianceStaff({ bucket: "transition", perMinute: 60, needAny: ["compliance.review", "compliance.approve", "compliance.execute"] }, async ({ admin, caller }) => {
    const { id } = await params;
    if (!UUID_RE.test(id)) return failure("not_found");
    const b = await readJsonBody<Record<string, unknown>>(request, 20_000);
    const to = oneStatus(b.to);
    if (!to) return failure("invalid_request");
    const identity = b.identity && typeof b.identity === "object" && !Array.isArray(b.identity) ? (b.identity as Record<string, unknown>) : null;
    const result = await transitionRequest(admin, caller, id, {
      to,
      note: typeof b.note === "string" ? b.note : null,
      identity: identity ? { method: String(identity.method ?? ""), methodOther: typeof identity.methodOther === "string" ? identity.methodOther : null, outcome: String(identity.outcome ?? "") } : null,
      recommendation: typeof b.recommendation === "string" ? b.recommendation : null,
      overrideReason: typeof b.overrideReason === "string" ? b.overrideReason : null,
    });
    return json(result);
  });
}
