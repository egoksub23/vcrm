// ============================================================
// POST /api/compliance/raise   (compliance.raise; NOT menu.compliance)
//
// "Raise compliance request" on an Inbox conversation or a ticket. Body: { typeKey, conversationId | ticketId, customerName, customerEmail?,
// customerPhone?, answers, channel?, receivedAt?, receivedAtReason?, note?, notify? }. The conversation or the ticket is read with the caller's own session,
// so a person can raise only from one they may open. The case is made by createComplianceRequest (source inbox or ticket), linked to the contact and to the
// conversation or ticket, and a line "Compliance request CMP-... raised" is left on it.
//
// Answers: 201 { reference, status, id?, notice? }. `id` only for a person who also holds a compliance permission. Never an answer, a bank detail or a
// reason. 409 duplicate_open when the customer already has an open request of this type; the reference is named (in issues) only to a person who holds a
// compliance permission. 400 note_required when the request date is earlier than a couple of minutes ago and no reason is given.
//
// Migration 185: `sendClosureForm: true` (an account closure raised from a conversation) also puts the customer's personal closure form in that chat, AFTER
// the case exists. The answer then carries `chatLink`: { status: "sent", ... } (no address), or { status: "not_sent", reason, url } when the chat could not
// take it (the 24-hour WhatsApp window is closed, the channel cannot carry it, the send failed): the personal `url` is in that answer ONCE, for the agent who
// just made it to copy, and is stored nowhere.
// ============================================================
import { chatLinkDepsFor } from "@/lib/compliance/chat-link/service";
import { complianceRaiser, failure, json, rateLimited, readJsonBody } from "@/lib/compliance/http";
import { realNoticeDeps } from "@/lib/compliance/service/notices";
import { raiseRequest, type RaiseInput } from "@/lib/compliance/service/raise";
import { RATE_LIMITS } from "@/lib/rate-limit";
import { checkSharedRateLimit } from "@/lib/rate-limit-shared";

export async function POST(request: Request) {
  return complianceRaiser({ bucket: "raise", perMinute: 20 }, async ({ admin, caller }) => {
    const b = await readJsonBody<Record<string, unknown>>(request, 120_000);
    const str = (k: string): string | null => (typeof b[k] === "string" ? (b[k] as string) : null);
    const typeKey = str("typeKey");
    const conversationId = str("conversationId");
    const ticketId = str("ticketId");
    if (!typeKey || (conversationId === null) === (ticketId === null)) return failure("invalid_request");
    // sending the closure form puts a message in a customer's chat: an hourly budget per person, shared across servers, on top of the minute's
    if (b.sendClosureForm === true) {
      const budget = await checkSharedRateLimit(`cmp:link:send:user:${caller.userId}`, RATE_LIMITS.complianceLinkSendUser);
      if (!budget.success) return rateLimited(budget.reset);
    }
    const answers = b.answers && typeof b.answers === "object" && !Array.isArray(b.answers) ? (b.answers as Record<string, unknown>) : {};
    const input: RaiseInput = {
      typeKey,
      target: conversationId ? { conversationId } : { ticketId: ticketId as string },
      customerName: str("customerName") ?? "",
      customerEmail: str("customerEmail"),
      customerPhone: str("customerPhone"),
      answers,
      channel: str("channel"),
      receivedAt: str("receivedAt"),
      receivedAtReason: str("receivedAtReason"),
      note: str("note"),
      notify: b.notify === true,
      sendClosureForm: b.sendClosureForm === true,
    };
    return json(await raiseRequest(admin, caller, input, realNoticeDeps, chatLinkDepsFor(request)), 201);
  });
}
