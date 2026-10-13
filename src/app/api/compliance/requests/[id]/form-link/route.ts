// ============================================================
// POST /api/compliance/requests/[id]/form-link   (compliance.raise, compliance.review or compliance.approve; NOT menu.compliance)
//
// The personal account closure form link of a case (migration 185). Body: { action: "resend" | "revoke" }.
//
//   resend   a NEW link is made (the old one stops working), and the card is put in the conversation the case is linked to. The answer is the same `chatLink`
//            as the raise's: { status: "sent", mode, ... } with no address, or { status: "not_sent", reason, url } when the chat could not take it (the
//            24-hour WhatsApp window is closed, the channel cannot carry it, the send failed). The personal `url` is in that answer ONCE, for the person who
//            just made it to copy, and is stored nowhere. Nothing is sent by itself: this is the agent pressing Resend.
//   revoke   the case's active link stops working. { revoked: false } when there was none.
//
// A person who holds review or approve acts on any case; a person who holds only compliance.raise, on the cases they raised. Ten links an hour per case and
// thirty per person. Every action is an event on the case (the action, the channel and the link's id; never the address).
// ============================================================
import { chatLinkDepsFor, resendClosureForm, revokeClosureForm } from "@/lib/compliance/chat-link/service";
import { complianceLinkActor, failure, json, rateLimited, readJsonBody, UUID_RE } from "@/lib/compliance/http";
import { RATE_LIMITS } from "@/lib/rate-limit";
import { checkSharedRateLimit } from "@/lib/rate-limit-shared";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return complianceLinkActor({ bucket: "form-link", perMinute: 20 }, async ({ admin, actor }) => {
    const { id } = await params;
    if (!UUID_RE.test(id)) return failure("not_found");
    const b = await readJsonBody<Record<string, unknown>>(request, 4_000);
    if (b.action === "revoke") return json(await revokeClosureForm(admin, actor, id));
    if (b.action !== "resend") return failure("invalid_request");
    const user = await checkSharedRateLimit(`cmp:link:send:user:${actor.userId}`, RATE_LIMITS.complianceLinkSendUser);
    if (!user.success) return rateLimited(user.reset);
    const perCase = await checkSharedRateLimit(`cmp:link:send:case:${id}`, RATE_LIMITS.complianceLinkSendCase);
    if (!perCase.success) return rateLimited(perCase.reset);
    return json({ chatLink: await resendClosureForm(admin, chatLinkDepsFor(request), actor, id) });
  });
}
