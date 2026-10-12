// ============================================================
// POST /api/compliance/requests/[id]/clock   (compliance.approve)
//
// Body: { action: "pause" | "resume", note: string }. The Head of Compliance pauses or resumes the regulatory clock of a case: a deliberate, logged action,
// a note is required, and only a type that allows it (off by default). On resume both deadlines move later by the time paused.
// ============================================================
import { complianceStaff, failure, json, readJsonBody, UUID_RE } from "@/lib/compliance/http";
import { clockAction } from "@/lib/compliance/service/actions";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return complianceStaff({ bucket: "clock", perMinute: 20, need: "compliance.approve" }, async ({ admin, caller }) => {
    const { id } = await params;
    if (!UUID_RE.test(id)) return failure("not_found");
    const b = await readJsonBody<Record<string, unknown>>(request, 10_000);
    if (b.action !== "pause" && b.action !== "resume") return failure("invalid_request");
    await clockAction(admin, caller, id, b.action, typeof b.note === "string" ? b.note : "");
    return json({ ok: true });
  });
}
