// ============================================================
// GET   /api/compliance/requests/[id]   (menu.compliance and a work capability)
// PATCH /api/compliance/requests/[id]   (compliance.review or compliance.approve)
//
// GET: one case for the screen: the customer, the answers, the sensitive answers as MASKS only, the identity check, the recommendation, the sign-off,
// the dues standing, the checklist, the files, the links and the timeline. A 'view' event is written first; when it cannot be written nothing is
// returned. PATCH: edit the customer's details, the answers, the request date, the links or the assignee. The answers and the customer's details
// can change only until the case goes to the Head of Compliance; links and the assignee until it is closed. Every change is an event.
// ============================================================
import { complianceStaff, failure, json, readJsonBody, UUID_RE } from "@/lib/compliance/http";
import { READ_CAPABILITIES } from "@/lib/compliance/routes-support";
import { getRequestDetail } from "@/lib/compliance/service/read";
import { editRequest, type EditRequestInput } from "@/lib/compliance/service/write";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return complianceStaff({ bucket: "detail", perMinute: 120, needAny: READ_CAPABILITIES }, async ({ admin, caller }) => {
    const { id } = await params;
    if (!UUID_RE.test(id)) return failure("not_found");
    return json(await getRequestDetail(admin, caller, id));
  });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return complianceStaff({ bucket: "edit", perMinute: 60, needAny: ["compliance.review", "compliance.approve"] }, async ({ admin, caller }) => {
    const { id } = await params;
    if (!UUID_RE.test(id)) return failure("not_found");
    const b = await readJsonBody<Record<string, unknown>>(request, 120_000);
    const input: EditRequestInput = {};
    const text = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : b[k] === null ? null : undefined);
    if (typeof b.customerName === "string") input.customerName = b.customerName;
    if (text("customerEmail") !== undefined) input.customerEmail = text("customerEmail");
    if (text("customerPhone") !== undefined) input.customerPhone = text("customerPhone");
    if (text("channel") !== undefined) input.channel = text("channel");
    if (typeof b.receivedAt === "string") input.receivedAt = b.receivedAt;
    if (b.answers && typeof b.answers === "object" && !Array.isArray(b.answers)) input.answers = b.answers as Record<string, unknown>;
    if (b.sensitive && typeof b.sensitive === "object" && !Array.isArray(b.sensitive)) input.sensitive = b.sensitive as Record<string, unknown>;
    for (const k of ["contactId", "conversationId", "ticketId", "incidentId", "kycValidationRef", "assignedTo"] as const) if (text(k) !== undefined) input[k] = text(k);
    return json(await editRequest(admin, caller, id, input));
  });
}
