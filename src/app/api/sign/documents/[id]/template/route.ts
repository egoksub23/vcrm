// ============================================================
// POST /api/sign/documents/[id]/template   (sign.templates)
//
// "Save as template": copy this draft's file, fields, roles and choices into a new template (a draft
// template to review). Body: { name, categoryId? }.
// ============================================================
import { UUID_RE, json, optionalId, readJson, staff } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { createTemplateFromDocument } from "@/lib/sign/service/templates";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return staff("sign.templates", request, async ({ ctx }) => {
    const { id } = await params;
    if (!UUID_RE.test(id)) throw new SignError("document_not_found", "That document was not found.", 404);
    const body = await readJson<{ name?: unknown; categoryId?: unknown }>(request);
    const name = typeof body.name === "string" ? body.name : "";
    const { template, version } = await createTemplateFromDocument(ctx, id, { name, categoryId: optionalId(body.categoryId) });
    return json({ template, version: { id: version.id, version_no: version.version_no } }, 201);
  });
}
