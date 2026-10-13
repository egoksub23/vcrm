// ============================================================
// GET /api/compliance/form-links?conversationId=...&ids=a,b   (compliance.raise, compliance.review or compliance.approve; NOT menu.compliance)
//
// The status of the closure form cards in one conversation (migration 185), for the Inbox thread: for each personal link sent in it, { id, state, expiresAt,
// canManage, requestId? } with `state` one of created, sent, opened, submitted, expired, revoked, replaced. Nothing about the customer, no answer, no address
// and no token: `requestId` only for a person who may resend or withdraw that link (review or approve; or compliance.raise on a case they raised).
//
// The conversation is read with the caller's own session, so a person asks only about a conversation they may open; another workspace's is "not found".
// ============================================================
import { cardStatuses } from "@/lib/compliance/chat-link/read";
import { complianceLinkActor, failure, json, UUID_RE } from "@/lib/compliance/http";
import { complianceError } from "@/lib/compliance/errors";

export async function GET(request: Request) {
  return complianceLinkActor({ bucket: "form-links", perMinute: 120 }, async ({ admin, actor, userDb }) => {
    const p = new URL(request.url).searchParams;
    const conversationId = p.get("conversationId");
    if (!conversationId || !UUID_RE.test(conversationId)) return failure("invalid_request");
    const ids = (p.get("ids") ?? "").split(",").map((s) => s.trim()).filter((s) => UUID_RE.test(s)).slice(0, 100);

    const { data, error } = await userDb.from("conversations").select("id, account_id").eq("id", conversationId).maybeSingle();
    if (error) throw complianceError("server_error");
    const c = data as { id: string; account_id: string } | null;
    if (!c || c.account_id !== actor.accountId) return failure("not_found");

    return json({ links: await cardStatuses(admin, actor, c.id, ids.length > 0 ? ids : null) });
  });
}
