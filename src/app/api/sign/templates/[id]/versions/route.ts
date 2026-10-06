// ============================================================
// POST /api/sign/templates/[id]/versions   (sign.templates)
//
// Save the editor: a new immutable version (fields, roles, defaults), made current. A document already
// sent from an older version keeps exactly what its signers were shown.
// Body: { fields, roles, defaults? }
// ============================================================
import { UUID_RE, json, readJson, staff } from "@/lib/sign/http";
import type { PlacedField } from "@/lib/sign/pdf/types";
import { SignError } from "@/lib/sign/service/errors";
import { saveTemplateVersion } from "@/lib/sign/service/templates";
import type { SignRole, TemplateDefaults } from "@/lib/sign/types";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return staff("sign.templates", request, async ({ ctx }) => {
    const { id } = await params;
    if (!UUID_RE.test(id)) throw new SignError("template_not_found", "That template was not found.", 404);
    const body = await readJson<{ fields?: unknown; roles?: unknown; defaults?: unknown }>(request);
    if (!Array.isArray(body.fields) || !Array.isArray(body.roles)) throw new SignError("bad_layout", "Send the fields and roles of the template.", 400);
    const version = await saveTemplateVersion(ctx, id, {
      fields: body.fields as PlacedField[],
      roles: body.roles as SignRole[],
      defaults: typeof body.defaults === "object" && body.defaults !== null ? (body.defaults as TemplateDefaults) : undefined,
    });
    return json({ version }, 201);
  });
}
