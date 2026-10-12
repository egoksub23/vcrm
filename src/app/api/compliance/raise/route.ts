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
// ============================================================
import { complianceRaiser, failure, json, readJsonBody } from "@/lib/compliance/http";
import { raiseRequest, type RaiseInput } from "@/lib/compliance/service/raise";

export async function POST(request: Request) {
  return complianceRaiser({ bucket: "raise", perMinute: 20 }, async ({ admin, caller }) => {
    const b = await readJsonBody<Record<string, unknown>>(request, 120_000);
    const str = (k: string): string | null => (typeof b[k] === "string" ? (b[k] as string) : null);
    const typeKey = str("typeKey");
    const conversationId = str("conversationId");
    const ticketId = str("ticketId");
    if (!typeKey || (conversationId === null) === (ticketId === null)) return failure("invalid_request");
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
    };
    return json(await raiseRequest(admin, caller, input), 201);
  });
}
