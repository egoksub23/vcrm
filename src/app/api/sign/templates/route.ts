// ============================================================
// POST /api/sign/templates   (sign.templates)
//
// A new template from an uploaded file (multipart: `file`, optional name and categoryId). PDF, Word and
// image files are accepted; Word and images are converted to the PDF that is edited and signed. The
// template starts as a draft with no fields. Reading templates is done by the screens through row level
// security (menu.sign).
// ============================================================
import { json, optionalId, readUpload, staff } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { createTemplateFromUpload } from "@/lib/sign/service/templates";

export async function POST(request: Request) {
  return staff(
    "sign.templates",
    request,
    async ({ ctx }) => {
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
