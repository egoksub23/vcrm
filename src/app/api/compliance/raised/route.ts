// ============================================================
// GET /api/compliance/raised?conversationId=...&ticketId=...&limit=   (compliance.raise; NOT menu.compliance)
//
// The raiser's minimal projection: the requests THEY raised (never anyone else's), newest first, each as { reference, typeKey, typeLabel, typeLabelL10n,
// status, raisedAt } with `status` one of received, in_review, in_progress, done, not_approved, closed. Narrowed to one conversation or one ticket when
// given. No customer, no answer, no bank detail, no reason, no note: a raiser reads their own case only this way (migration 184 took away the direct
// read of the case row). `id` is added only for a person who also holds a compliance permission, to open the case.
// ============================================================
import { complianceRaiser, json } from "@/lib/compliance/http";
import { raisedByMe } from "@/lib/compliance/service/raise";

export async function GET(request: Request) {
  return complianceRaiser({ bucket: "raised", perMinute: 120 }, async ({ admin, caller }) => {
    const p = new URL(request.url).searchParams;
    const limit = Number(p.get("limit"));
    return json({ items: await raisedByMe(admin, caller, { conversationId: p.get("conversationId"), ticketId: p.get("ticketId"), limit: Number.isFinite(limit) && limit > 0 ? limit : undefined }) });
  });
}
