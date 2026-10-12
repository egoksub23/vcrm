// ============================================================
// PATCH /api/compliance/types/[key]   (compliance.manage)
//
// Edit a request type: label, labels in Malay / Chinese / Korean, the clocks (target and hard stop in days, null for none; they apply to NEW cases only),
// the identity check switch, the dues block, the pause switch, active, the checklist template, and (a custom type only) the fields.
// ============================================================
import { complianceStaff, failure, json, readJsonBody } from "@/lib/compliance/http";
import { updateType, type TypePatch } from "@/lib/compliance/service/types-admin";

export async function PATCH(request: Request, { params }: { params: Promise<{ key: string }> }) {
  return complianceStaff({ bucket: "types-write", perMinute: 30, need: "compliance.manage" }, async ({ admin, caller }) => {
    const { key } = await params;
    if (!/^[a-z][a-z0-9_]{1,39}$/.test(key)) return failure("not_found");
    const b = await readJsonBody<Record<string, unknown>>(request, 120_000);
    const patch: TypePatch = {};
    if (typeof b.label === "string") patch.label = b.label;
    if (b.labelL10n && typeof b.labelL10n === "object" && !Array.isArray(b.labelL10n)) patch.labelL10n = b.labelL10n as Record<string, string>;
    if (b.targetDays !== undefined) patch.targetDays = b.targetDays as number | null;
    if (b.hardStopDays !== undefined) patch.hardStopDays = b.hardStopDays as number | null;
    for (const k of ["requiresIdentityCheck", "checkDues", "allowPause", "active"] as const) if (b[k] !== undefined) patch[k] = b[k] as boolean;
    if (typeof b.position === "number") patch.position = b.position;
    if (b.checklist !== undefined) patch.checklist = b.checklist;
    if (b.fields !== undefined) patch.fields = b.fields;
    return json({ type: await updateType(admin, caller, key, patch) });
  });
}
