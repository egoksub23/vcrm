// ============================================================
// GET /api/compliance/raise/context?conversationId=...  (or ?ticketId=...)   (compliance.raise; NOT menu.compliance)
//
// What the "Raise compliance request" dialog needs: the customer's name, phone, email and language from the contact (the person can already see them on
// the conversation or the ticket), the channel, the request types with the fields a member of staff fills (no files, no public-form helpers), and which
// types the customer already has an open request for (a flag: never the reference). The conversation or ticket is read with the caller's own session.
// ============================================================
import { complianceRaiser, failure, json } from "@/lib/compliance/http";
import { raiseContext } from "@/lib/compliance/service/raise";

export async function GET(request: Request) {
  return complianceRaiser({ bucket: "raise-context", perMinute: 60 }, async ({ admin, caller }) => {
    const p = new URL(request.url).searchParams;
    const conversationId = p.get("conversationId");
    const ticketId = p.get("ticketId");
    if ((conversationId === null) === (ticketId === null)) return failure("invalid_request");
    return json(await raiseContext(admin, caller, conversationId ? { conversationId } : { ticketId: ticketId as string }));
  });
}
