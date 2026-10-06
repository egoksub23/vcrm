// ============================================================
// POST /api/sign/templates/[id]/duplicate   (sign.templates)
//
// A copy of a template as a new draft template: for another set of terms or another merchant group.
// Body: { name? }
// ============================================================
import { UUID_RE, json, readJson, staff } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { duplicateTemplate } from "@/lib/sign/service/templates";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return staff("sign.templates", request, async ({ ctx }) => {
    const { id } = await params;
    if (!UUID_RE.test(id)) throw new SignError("template_not_found", "That template was not found.", 404);
    const body = await readJson<{ name?: unknown }>(request);
    const { template } = await duplicateTemplate(ctx, id, typeof body.name === "string" ? body.name : undefined);
    return json({ template }, 201);
  });
}
