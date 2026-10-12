// ============================================================
// POST /api/compliance/requests/[id]/notices   (menu.compliance and compliance.review or compliance.approve)
//
// The emails to the customer that a person writes or checks (migration 184).
//   { action: "preview", kind, text?, language? }                    what the email would say: the subject and the plain-text body, in the customer's
//                                                                   language (or the one named). Writes nothing and sends nothing.
//   { action: "send", kind: "more_info", text, nonce, language? }   ask the customer for more information. `text` is the officer's own words (refused if
//                                                                   it carries the case's bank account number or phone number); `nonce` is made by the
//                                                                   screen so a double click or a retry is ONE email. Logged on the case with who sent it.
//   { action: "send", kind, resend: true }                          send again a notice that FAILED (received, approved, rejected, completed). A notice
//                                                                   that was sent is never sent twice.
// Answers: { notice: { status: "sent" | "failed" | "skipped" | "duplicate", detail?, language? } } or { preview: { subject, body, language, hasAddress } }.
// Nothing here returns an address.
// ============================================================
import { complianceStaff, failure, json, readJsonBody, UUID_RE } from "@/lib/compliance/http";
import { previewCustomerNotice, realNoticeDeps, sendCustomerNotice } from "@/lib/compliance/service/notices";
import { customerLocaleOf, type CustomerNotice } from "@/lib/compliance/messages";

const KINDS: readonly CustomerNotice[] = ["received", "more_info", "approved", "rejected", "completed"];

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return complianceStaff({ bucket: "notices", perMinute: 30, needAny: ["compliance.review", "compliance.approve"] }, async ({ admin, caller }) => {
    const { id } = await params;
    if (!UUID_RE.test(id)) return failure("not_found");
    const b = await readJsonBody<Record<string, unknown>>(request, 20_000);
    const kind = KINDS.find((k) => k === b.kind);
    if (!kind) return failure("invalid_request");
    const language = customerLocaleOf(typeof b.language === "string" ? b.language : null);
    const text = typeof b.text === "string" ? b.text : null;
    if (b.action === "preview") return json({ preview: await previewCustomerNotice(admin, caller, id, { kind, text, language }) });
    if (b.action !== "send") return failure("invalid_request");
    const resend = b.resend === true;
    // a new send is only for the one email a person writes; everything else is sent by the move it belongs to (or sent again after it failed)
    if (kind !== "more_info" && !resend) return failure("invalid_request");
    const notice = await sendCustomerNotice(admin, realNoticeDeps, {
      accountId: caller.accountId,
      requestId: id,
      kind,
      text,
      key: typeof b.nonce === "string" ? b.nonce : undefined,
      actor: caller.userId,
      language,
      retry: resend,
    });
    return json({ notice });
  });
}
