// ============================================================
// GET  /api/compliance/types    (menu.compliance and a work capability or compliance.manage)
// POST /api/compliance/types    (compliance.manage)
//
// GET: the request type definitions of the workspace (fields, checklist template, clocks, switches); the New request form and the settings screen read
// them. An administrator (compliance.manage) also gets the inactive ones. POST: add a custom type { key, label, fields, checklist?, targetDays?, ... }.
// ============================================================
import { complianceStaff, json, readJsonBody } from "@/lib/compliance/http";
import { READ_CAPABILITIES } from "@/lib/compliance/routes-support";
import { loadTypes } from "@/lib/compliance/service/rows";
import { createType, type NewType } from "@/lib/compliance/service/types-admin";

export async function GET() {
  return complianceStaff({ bucket: "types", perMinute: 60, needAny: [...READ_CAPABILITIES, "compliance.manage"] }, async ({ admin, caller }) => {
    const types = await loadTypes(admin, caller.accountId);
    return json({ types: caller.viewer.canManage ? types : types.filter((t) => t.active), viewer: caller.viewer });
  });
}

export async function POST(request: Request) {
  return complianceStaff({ bucket: "types-write", perMinute: 20, need: "compliance.manage" }, async ({ admin, caller }) => {
    const b = await readJsonBody<Record<string, unknown>>(request, 120_000);
    const input: NewType = {
      key: typeof b.key === "string" ? b.key : "",
      label: typeof b.label === "string" ? b.label : "",
      fields: b.fields ?? [],
    };
    if (b.checklist !== undefined) input.checklist = b.checklist;
    if (b.targetDays !== undefined) input.targetDays = b.targetDays as number | null;
    if (b.hardStopDays !== undefined) input.hardStopDays = b.hardStopDays as number | null;
    for (const k of ["requiresIdentityCheck", "checkDues", "allowPause"] as const) if (typeof b[k] === "boolean") input[k] = b[k] as boolean;
    return json({ type: await createType(admin, caller, input) }, 201);
  });
}
