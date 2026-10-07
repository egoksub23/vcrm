// ============================================================
// DELETE /api/sign/documents/[id]/copies/[copyId]   (sign.send)
//
// Stop a person receiving a copy of this document. Only while the document is a draft or open. A person of another document or workspace is "not found".
// ============================================================
import { UUID_RE, json, staff } from "@/lib/sign/http";
import { removeCopyRecipient } from "@/lib/sign/service/copy-recipients";
import { SignError } from "@/lib/sign/service/errors";

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string; copyId: string }> }) {
  return staff("sign.send", request, async ({ ctx }) => {
    const { id, copyId } = await params;
    if (!UUID_RE.test(id)) throw new SignError("document_not_found", "That document was not found.", 404);
    if (!UUID_RE.test(copyId)) throw new SignError("copy_recipient_not_found", "That person was not found.", 404);
    await removeCopyRecipient(ctx, { documentId: id }, copyId);
    return json({ removed: true });
  });
}
