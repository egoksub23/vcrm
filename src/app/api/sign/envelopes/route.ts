// ============================================================
// POST /api/sign/envelopes   (sign.send)
//
// Start a document collection (the envelopes of migration 171): two to six documents signed by the same people in one sitting. Each document
// is a template or a file of the sender's own (a PDF, Word file or image, converted as for any document), in any mix and in the order given.
//
//   JSON       `templateIds` (the active templates, in the order the documents will be signed), or `order`; optional `title`, `contactId`,
//              `ticketId`, `dealId`, `isPrivate` (migration 176: the collection, and so each document of it, is seen only by whoever uploads it, the
//              workspace's admins and the Halo users named on it)
//   multipart  the same fields as text, with any number of `file` parts (up to six, 60 MB in all) and `order`: a JSON list that interleaves
//              { kind: "file", index } (the n-th `file` part) and { kind: "template", id }, each with an optional `title`. Without `order`, the
//              files come first in the order they were sent, then `templateIds` (so one `file` with `templateIds` works as it always did).
//
// Each document is made by the same service a document alone is made by; the answer lists them. If one cannot be made, none is kept.
// People, options and sending are on the collection's own routes; documents are added, removed and reordered on ./[id]/documents.
// ============================================================
import { json, optionalId, staff } from "@/lib/sign/http";
import { createEnvelopeDraft } from "@/lib/sign/service/envelopes";
import { readCollectionRequest } from "@/lib/sign/service/envelope-request";
import { parsePrivate } from "@/lib/sign/service/privacy";

export async function POST(request: Request) {
  return staff(
    "sign.send",
    request,
    async ({ ctx }) => {
      const body = await readCollectionRequest(request);
      const made = await createEnvelopeDraft(ctx, {
        title: typeof body.data.title === "string" ? body.data.title : null,
        templateIds: body.templateIds,
        files: body.uploads,
        order: body.order,
        contactId: optionalId(body.data.contactId),
        ticketId: optionalId(body.data.ticketId),
        dealId: optionalId(body.data.dealId),
        isPrivate: parsePrivate(body.data.isPrivate),
      });
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
