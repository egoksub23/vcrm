// ============================================================
// POST /api/sign/templates   (sign.templates)
//
// A new template from an uploaded file (multipart: `file`, optional name and categoryId). PDF, Word and
// image files are accepted; Word and images are converted to the PDF that is edited and signed. The
// template starts as a draft with no fields. Reading templates is done by the screens through row level
// security (menu.sign).
//
// A new template for a form WITHOUT a signature (migration 169): JSON `{ mode: "form", name, categoryId? }`. No file is
// needed; the template starts with one role that fills in, and the form builder adds the parts.
// ============================================================
import { json, optionalId, readJson, readUpload, staff } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { createFormTemplate, createTemplateFromUpload } from "@/lib/sign/service/templates";

export async function POST(request: Request) {
  return staff(
    "sign.templates",
    request,
    async ({ ctx }) => {
      if ((request.headers.get("content-type") ?? "").includes("application/json")) {
        const body = await readJson<{ mode?: unknown; name?: unknown; categoryId?: unknown }>(request);
        if (body.mode !== "form") throw new SignError("bad_mode", "Choose a template from a file, or a form without a signature.", 400);
        const made = await createFormTemplate(ctx, { name: typeof body.name === "string" ? body.name : "", categoryId: optionalId(body.categoryId) });
        return json({ template: made.template, version: { id: made.version.id, version_no: made.version.version_no, page_count: made.version.page_count }, converted: false }, 201);
      }
      const { file, fields } = await readUpload(request);
      if (!file) throw new SignError("no_file", "Choose a file to upload.", 400);
      const { template, version, converted } = await createTemplateFromUpload(ctx, {
        bytes: file.bytes,
        filename: file.name,
        name: fields.name,
        categoryId: optionalId(fields.categoryId),
      });
      return json({ template, version: { id: version.id, version_no: version.version_no, page_count: version.page_count }, converted }, 201);
    },
    { rate: { limit: 20, windowMs: 60_000 } },
  );
}
