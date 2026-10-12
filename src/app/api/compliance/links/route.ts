// ============================================================
// GET /api/compliance/links?kind=contact|ticket|incident&q=<text or number>   (compliance.review or compliance.approve)
//
// Up to five contacts, tickets or incidents of the caller's own workspace to link a case to. A ticket or incident is found by its number or its
// subject, a contact by name, phone or email. The choice's id goes back through PATCH /api/compliance/requests/[id].
// ============================================================
import { complianceStaff, failure, json } from "@/lib/compliance/http";
import { LINK_KINDS, lookupLinks, type LinkChoice } from "@/lib/compliance/service/links";

export async function GET(request: Request) {
  return complianceStaff({ bucket: "links", perMinute: 60, needAny: ["compliance.review", "compliance.approve"] }, async ({ admin, caller }) => {
    const params = new URL(request.url).searchParams;
    const kind = params.get("kind") ?? "";
    if (!(LINK_KINDS as readonly string[]).includes(kind)) return failure("invalid_request");
    const q = (params.get("q") ?? "").slice(0, 100);
    return json({ choices: await lookupLinks(admin, caller, kind as LinkChoice["kind"], q) });
  });
}
