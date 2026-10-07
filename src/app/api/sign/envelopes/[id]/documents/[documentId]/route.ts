// ============================================================
// DELETE /api/sign/envelopes/[id]/documents/[documentId]   (sign.send)
//
// Remove one document from a document collection that is still a draft: the draft document is deleted with its files and the places of the
// others close up. Only a draft is ever deleted (409 document_not_draft for anything else, 409 envelope_not_draft once the collection was sent);
// a collection keeps at least two documents (409 envelope_minimum); a document that is not in this collection is 404.
// ============================================================
import { UUID_RE, json, staff } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { removeEnvelopeDocument } from "@/lib/sign/service/envelope-documents";

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string; documentId: string }> }) {
  return staff("sign.send", request, async ({ ctx }) => {
    const { id, documentId } = await params;
    if (!UUID_RE.test(id)) throw new SignError("envelope_not_found", "That document collection was not found.", 404);
    if (!UUID_RE.test(documentId)) throw new SignError("document_not_found", "That document was not found.", 404);
    const made = await removeEnvelopeDocument(ctx, id, documentId);
    return json({ documents: made.documents.map((d) => ({ id: d.id, reference: d.reference, title: d.title, position: d.envelope_position ?? 0, pageCount: d.page_count })) });
  });
}
