// ============================================================
// GET   /api/compliance/public-forms   (menu.compliance and compliance.manage)
// PATCH /api/compliance/public-forms   (compliance.manage)
//
// Settings > Compliance > Public forms: the account closure form and the fund withdrawal form that parents fill in at /c/<slug>.
// GET answers { forms: [{ typeKey, exists, enabled, slug, notice, turnstile, maxAmount, banks, ready }], turnstileAvailable }.
// PATCH body: { typeKey, enabled?, notice?: { en, ms, zh, ko }, turnstile?, maxAmount?, banks?, regenerateSlug? } and answers the same as GET. A form can be
// switched on only when its type is active and carries the fields the form fills. A phone change has no public form. The form works only while the
// operator's `compliance` flag is on for the workspace as well.
// ============================================================
import { complianceStaff, failure, json, readJsonBody } from "@/lib/compliance/http";
import { listPublicForms, savePublicForm, type PublicFormPatch } from "@/lib/compliance/public/settings";

export async function GET() {
  return complianceStaff({ bucket: "public-forms", perMinute: 60, need: "compliance.manage" }, async ({ admin, caller }) => json(await listPublicForms(admin, caller)));
}

export async function PATCH(request: Request) {
  return complianceStaff({ bucket: "public-forms-write", perMinute: 20, need: "compliance.manage" }, async ({ admin, caller }) => {
    const b = await readJsonBody<Record<string, unknown>>(request, 40_000);
    if (typeof b.typeKey !== "string") return failure("invalid_request");
    const patch: PublicFormPatch = {};
    if (b.enabled !== undefined) patch.enabled = b.enabled as boolean;
    if (b.notice !== undefined) {
      if (!b.notice || typeof b.notice !== "object" || Array.isArray(b.notice)) return failure("invalid_request");
      patch.notice = b.notice as Record<string, unknown>;
    }
    if (b.turnstile !== undefined) patch.turnstile = b.turnstile as boolean;
    if (b.maxAmount !== undefined) patch.maxAmount = b.maxAmount as number;
    if (b.banks !== undefined) patch.banks = b.banks as PublicFormPatch["banks"];
    if (b.regenerateSlug === true) patch.regenerateSlug = true;
    return json(await savePublicForm(admin, caller, b.typeKey, patch));
  });
}
