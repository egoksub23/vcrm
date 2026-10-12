// ============================================================
// POST /api/compliance/requests/[id]/steps/[step]   (compliance.execute)
//
// Body: { done: boolean, note?: string }. Tick (or untick) one step of the operations checklist, with who and when. Only while the case is approved or
// executing; the first tick moves an approved case to executing. The database function (compliance_tick_step) re-checks compliance.execute for the
// named person and writes the event.
// ============================================================
import { complianceStaff, failure, json, readJsonBody, UUID_RE } from "@/lib/compliance/http";
import { tickStep } from "@/lib/compliance/service/actions";

export async function POST(request: Request, { params }: { params: Promise<{ id: string; step: string }> }) {
  return complianceStaff({ bucket: "step", perMinute: 60, need: "compliance.execute" }, async ({ admin, caller }) => {
    const { id, step } = await params;
    if (!UUID_RE.test(id)) return failure("not_found");
    const b = await readJsonBody<Record<string, unknown>>(request, 10_000);
    if (typeof b.done !== "boolean") return failure("invalid_request");
    await tickStep(admin, caller, id, step, b.done, typeof b.note === "string" ? b.note : null);
    return json({ ok: true });
  });
}
