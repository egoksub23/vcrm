// ============================================================
// POST /api/compliance/requests/[id]/notes   (compliance.review or compliance.approve)
//
// Body: { text: string } (1 to 2000 characters). Add a note to the case's timeline. Notes cannot be edited or removed (the trail is append-only).
// ============================================================
import { complianceStaff, failure, json, readJsonBody, UUID_RE } from "@/lib/compliance/http";
import { addNote } from "@/lib/compliance/service/write";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return complianceStaff({ bucket: "note", perMinute: 30, needAny: ["compliance.review", "compliance.approve"] }, async ({ admin, caller }) => {
    const { id } = await params;
    if (!UUID_RE.test(id)) return failure("not_found");
    const b = await readJsonBody<Record<string, unknown>>(request, 10_000);
    await addNote(admin, caller, id, typeof b.text === "string" ? b.text : "");
    return json({ ok: true }, 201);
  });
}
