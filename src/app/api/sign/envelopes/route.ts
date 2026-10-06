// ============================================================
// POST /api/sign/envelopes   (sign.send)
//
// Start an envelope (migration 171): two to six documents signed by the same people in one sitting. JSON: `templateIds` (the active templates,
// in the order the documents will be signed), optional `title`, `contactId`, `ticketId`, `dealId`. Or multipart: the same fields (`templateIds`
// as a JSON list) and one `file`, which becomes the first document (a PDF, Word file or image, converted as for any document). Each document
// is made by the same service a document alone is made by; the answer lists them. People, options and sending are on the envelope's own routes.
// ============================================================
import { UUID_RE, json, optionalId, readJson, readUpload, staff } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { createEnvelopeDraft } from "@/lib/sign/service/envelopes";

function templateIdsOf(raw: unknown): string[] {
  let list: unknown = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      list = raw.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.some((x) => typeof x !== "string" || !UUID_RE.test(x))) throw new SignError("template_required", "Choose the templates.", 400);
  return list as string[];
}

export async function POST(request: Request) {
  return staff(
    "sign.send",
    request,
    async ({ ctx }) => {
      const type = (request.headers.get("content-type") ?? "").toLowerCase();
      let made;
      if (type.includes("multipart/form-data")) {
        const { file, fields } = await readUpload(request);
        if (!file) throw new SignError("no_file", "Choose a file to upload.", 400);
        made = await createEnvelopeDraft(ctx, {
          title: fields.title,
          templateIds: templateIdsOf(fields.templateIds),
          file: { bytes: file.bytes, filename: file.name },
          contactId: optionalId(fields.contactId),
          ticketId: optionalId(fields.ticketId),
          dealId: optionalId(fields.dealId),
        });
      } else {
        const body = await readJson<{ templateIds?: unknown; title?: unknown; contactId?: unknown; ticketId?: unknown; dealId?: unknown }>(request);
        made = await createEnvelopeDraft(ctx, {
          title: typeof body.title === "string" ? body.title : null,
          templateIds: templateIdsOf(body.templateIds),
          contactId: optionalId(body.contactId),
          ticketId: optionalId(body.ticketId),
          dealId: optionalId(body.dealId),
        });
      }
      return json(
        {
          envelope: { id: made.envelope.id, reference: made.envelope.reference, title: made.envelope.title, status: made.envelope.status },
          documents: made.documents.map((d) => ({ id: d.id, reference: d.reference, title: d.title, position: d.envelope_position ?? 0, pageCount: d.page_count })),
        },
        201,
      );
    },
    { rate: { limit: 20, windowMs: 60_000 } },
  );
}
