// ============================================================
// GET  /api/compliance/requests?type=&status=a,b&due=&assignee=&mine=1&q=&from=&to=&page=&page_size=   (menu.compliance and a work capability)
// POST /api/compliance/requests                                                                         (compliance.review or compliance.approve)
//
// GET: the list, newest first, with the header counts of the workspace's open cases and the filters' choices. It carries no answers and no
// sensitive value. POST: a member of staff raises a case (for a request that came in a chat): the body is the type's key, the customer's name, email,
// phone, the channel, the request date (optional; audited as back-dated in the created event), the answers of the type's form, and optional links
// (contactId, conversationId, ticketId, incidentId, kycValidationRef). The sensitive answers are encrypted before they are stored.
// menu.compliance alone opens neither: a work capability (review, approve, execute or reveal) is needed as well.
// ============================================================
import { complianceStaff, failure, json, readJsonBody } from "@/lib/compliance/http";
import { READ_CAPABILITIES } from "@/lib/compliance/routes-support";
import { listRequests, parseListFilters } from "@/lib/compliance/service/read";
import { createComplianceRequest } from "@/lib/compliance/service/write";

export async function GET(request: Request) {
  return complianceStaff({ bucket: "list", perMinute: 120, needAny: READ_CAPABILITIES }, async ({ admin, caller }) =>
    json(await listRequests(admin, caller, parseListFilters(new URL(request.url).searchParams))),
  );
}

export async function POST(request: Request) {
  return complianceStaff({ bucket: "create", perMinute: 20, needAny: ["compliance.review", "compliance.approve"] }, async ({ admin, caller }) => {
    const b = await readJsonBody<Record<string, unknown>>(request, 120_000);
    const str = (k: string): string | null => (typeof b[k] === "string" ? (b[k] as string) : null);
    const typeKey = str("typeKey");
    if (!typeKey) return failure("invalid_request");
    // staff raise a case from their own screen ("staff"), from the Inbox or from a ticket (Part B's buttons); never "form" (that is the public form)
    const source = b.source === "inbox" || b.source === "ticket" ? b.source : "staff";
    const answers = b.answers && typeof b.answers === "object" && !Array.isArray(b.answers) ? (b.answers as Record<string, unknown>) : {};
    const created = await createComplianceRequest(admin, {
      accountId: caller.accountId,
      typeKey,
      source,
      channel: str("channel"),
      customerName: str("customerName") ?? "",
      customerEmail: str("customerEmail"),
      customerPhone: str("customerPhone"),
      answers,
      receivedAt: str("receivedAt"),
      createdBy: caller.userId,
      assignedTo: str("assignedTo"),
      contactId: str("contactId"),
      conversationId: str("conversationId"),
      ticketId: str("ticketId"),
      incidentId: str("incidentId"),
      kycValidationRef: str("kycValidationRef"),
    });
    return json(created, 201);
  });
}
