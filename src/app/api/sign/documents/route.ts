// ============================================================
// POST /api/sign/documents   (sign.send)
//
// Start a document: a draft from an uploaded file (multipart: `file`, optional title, categoryId,
// contactId) or from a template (JSON: templateId, optional title, categoryId, contactId). The file is
// checked, converted if it is Word or an image, and stored; the draft is returned for the editor.
// Reading documents is done by the screens through row level security (menu.sign).
// ============================================================
import { UUID_RE, json, optionalId, readJson, readUpload, staff } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { createDraftFromTemplate, createDraftFromUpload } from "@/lib/sign/service/drafts";

const summary = (d: { id: string; reference: string | null; title: string; status: string; page_count: number | null }) => ({
  id: d.id,
  reference: d.reference,
  title: d.title,
  status: d.status,
  pageCount: d.page_count,
});

export async function POST(request: Request) {
  return staff(
    "sign.send",
    request,
    async ({ ctx }) => {
      const type = (request.headers.get("content-type") ?? "").toLowerCase();
      if (type.includes("multipart/form-data")) {
        const { file, fields } = await readUpload(request);
        if (!file) throw new SignError("no_file", "Choose a file to upload.", 400);
        const { document, converted } = await createDraftFromUpload(ctx, {
          bytes: file.bytes,
          filename: file.name,
          title: fields.title,
          categoryId: optionalId(fields.categoryId),
          contactId: optionalId(fields.contactId),
          ticketId: optionalId(fields.ticketId),
          dealId: optionalId(fields.dealId),
        });
        return json({ document: summary(document), converted }, 201);
      }
      const body = await readJson<{ templateId?: unknown; title?: unknown; categoryId?: unknown; contactId?: unknown; ticketId?: unknown; dealId?: unknown }>(request);
      if (typeof body.templateId !== "string" || !UUID_RE.test(body.templateId)) throw new SignError("template_required", "Choose a template or upload a file.", 400);
      const document = await createDraftFromTemplate(ctx, {
        templateId: body.templateId,
        title: typeof body.title === "string" ? body.title : null,
        categoryId: optionalId(body.categoryId),
        contactId: optionalId(body.contactId),
        ticketId: optionalId(body.ticketId),
        dealId: optionalId(body.dealId),
      });
      return json({ document: summary(document) }, 201);
    },
    { rate: { limit: 30, windowMs: 60_000 } },
  );
}
