// ============================================================
// POST /api/sign/templates/[id]/versions   (sign.templates)
//
// Save the editor: a new immutable version (fields, roles, defaults, form), made current. A document already
// sent from an older version keeps exactly what its signers were shown.
// Body: { fields, roles, defaults?, form? }  (leave `form` out to keep the current form, send null to remove it)
// Answer: { version, warnings } (201). An unsound layout or form is refused with 400 `invalid_layout` and the
// issues; fixed text that does not fit its box is only a warning (`static_text_does_not_fit`).
// ============================================================
import { UUID_RE, json, readJson, staff } from "@/lib/sign/http";
import type { FormDefinition } from "@/lib/sign/forms";
import type { PlacedField } from "@/lib/sign/pdf/types";
import { SignError } from "@/lib/sign/service/errors";
import { saveTemplateVersion } from "@/lib/sign/service/templates";
import type { SignRole, TemplateDefaults } from "@/lib/sign/types";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return staff("sign.templates", request, async ({ ctx }) => {
    const { id } = await params;
    if (!UUID_RE.test(id)) throw new SignError("template_not_found", "That template was not found.", 404);
    const body = await readJson<{ fields?: unknown; roles?: unknown; defaults?: unknown; form?: unknown }>(request);
    if (!Array.isArray(body.fields) || !Array.isArray(body.roles)) throw new SignError("bad_layout", "Send the fields and roles of the template.", 400);
    if (body.form !== undefined && body.form !== null && (typeof body.form !== "object" || Array.isArray(body.form))) throw new SignError("bad_form", "The form is not valid.", 400);
    const { version, warnings } = await saveTemplateVersion(ctx, id, {
      fields: body.fields as PlacedField[],
      roles: body.roles as SignRole[],
      defaults: typeof body.defaults === "object" && body.defaults !== null ? (body.defaults as TemplateDefaults) : undefined,
      form: body.form as FormDefinition | null | undefined,
    });
    return json({ version, warnings }, 201);
  });
}
